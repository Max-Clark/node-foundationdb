#!/usr/bin/env node -r ts-node/register --enable-source-maps

// This file implements the foundationdb binding API tester fuzzer backend
// described here:
// 
// https://github.com/apple/foundationdb/blob/master/bindings/bindingtester/spec/bindingApiTester.md

// This script should not be invoked directly. Instead checkout foundationdb
// and invoke the binding tester from there, pointing it at this script.

import * as fdb from '../lib'
import {
  Transaction, Database,
  tuple, TupleItem,
  keySelector,
  StreamingMode, MutationType,
  util,
  TransactionOptionCode,
} from '../lib'

// TODO: Expose these in lib
import {packPrefixedVersionstamp} from '../lib/versionstamp'

import assert = require('assert')
import nodeUtil = require('util')
import * as chalk from 'chalk'
import fs = require('fs')

let verbose = false

// The string keys are all buffers, encoded as hex.
// This is shared between all threads.
const transactions: {[k: string]: Transaction} = {}

// 'RESULT_NOT_PRESENT' -> 'ResultNotPresent'
const toUpperCamelCase = (str: string) => (
  str.toLowerCase().replace(/(^\w|_\w)/g, x => x[x.length-1].toUpperCase())
)

const toStr = (val: any): string => (
  (typeof val === 'object' && val.data) ? toStr(val.data)
  : Buffer.isBuffer(val) ? val.toString('ascii')
  : nodeUtil.inspect(val)
)

const colors = [chalk.blueBright, chalk.red, chalk.cyan, chalk.greenBright, chalk.grey]
const makeMachine = (db: Database, initialName: Buffer) => {
  type StackItem = {instrId: number, data: any}
  const stack: StackItem[] = []
  let tnName = initialName
  let instrId = 0
  let lastVersion: Buffer = Buffer.alloc(8) // null / empty last version.

  const threadColor = colors.pop()!
  colors.unshift(threadColor)

  const tnNameKey = () => tnName.toString('hex')

  const catchFdbErr = (e: Error) => {
    if (e instanceof fdb.FDBError) {
      // This encoding is silly. Also note that these errors are normal & part of the test.
      if (verbose) console.log(chalk.red('output error'), instrId, e)
      return fdb.tuple.pack([Buffer.from('ERROR'), Buffer.from(e.code.toString())])
    } else throw e
  }

  const unwrapNull = <T>(val: T | null) => val == null ? Buffer.from('RESULT_NOT_PRESENT') : val
  const wrapP = <T>(p: T | Promise<T>) => (p instanceof Promise) ? p.then(unwrapNull, catchFdbErr) : unwrapNull(p)

  const popValue = async () => {
    assert(stack.length, 'popValue when stack is empty')
    if (verbose) {
      console.log(chalk.green('pop value'), stack[stack.length-1].instrId, stack[stack.length-1].data)
    }
    return stack.pop()!.data
  }
  const chk = async <T>(pred: (item: any) => boolean, typeLabel: string): Promise<T> => {
    const {instrId} = stack[stack.length-1]
    let val = await popValue()
    assert(pred(val), `${threadColor('Unexpected type')} of ${nodeUtil.inspect(val, false, undefined, true)} inserted at ${instrId} - espected ${typeLabel}`)
    return val as any as T // :(
  }
  const popStr = () => chk<string>(val => typeof val === 'string', 'string')
  const popBool = () => chk<boolean>(val => val === 0 || val === 1, 'bool').then(x => !!x)
  const popInt = () => chk<number | bigint>(val => Number.isInteger(val) || typeof val === 'bigint', 'int')
  const popBuffer = () => chk<Buffer>(Buffer.isBuffer, 'buf')
  const popStrBuf = () => chk<string | Buffer>(val => typeof val === 'string' || Buffer.isBuffer(val), 'buf|str')
  const popSelector = async () => {
    const key = await popBuffer()
    const orEqual = await popBool()
    const offset = await popInt()
    return keySelector(key, orEqual, Number(offset))
  }
  const popNValues = async () => {
    const n = await popInt()
    const result = []
    for (let i = 0; i < n; i++) result.push(await popValue())
    return result
  }

  const pushValue = (data: any) => {
    if (verbose) console.log('pushValue', instrId, data)
    stack.push({instrId, data})
  }
  const pushTupleItem = (data: TupleItem) => pushValue(data)
  const pushLiteral = (data: string) => pushValue(Buffer.from(data, 'ascii'))
  const maybePush = (data: Promise<void> | void) => {
    if (data) pushValue(wrapP(data))
  }

  // const orNone = (val: Buffer | null) => val == null ? 'RESULT_NOT_PRESENT' : val
  const bufBeginsWith = (buf: Buffer, prefix: Buffer) => (
    prefix.length <= buf.length && buf.compare(prefix, 0, prefix.length, 0, prefix.length) === 0
  )

  const operations: {[op: string]: (operand: Database | Transaction, ...args: TupleItem[]) => any} = {
    // Stack operations
    PUSH(_, data: any) { pushValue(data) },
    POP() { stack.pop() },
    DUP() { stack.push(stack[stack.length-1]) },
    EMPTY_STACK() { stack.length = 0 },
    async SWAP() {
      // TODO: Should this wait for the promises in question to resolve?
      const depth = Number(await popInt())
      assert(depth < stack.length)
      const a = stack[stack.length - depth - 1]
      const b = stack[stack.length - 1]

      stack[stack.length - depth - 1] = b
      stack[stack.length - 1] = a
    },
    async SUB() {
      const a = await popInt()
      const b = await popInt()
      pushValue(BigInt(a) - BigInt(b))
    },
    async CONCAT() {
      const a = await popStrBuf() // both strings or both bytes.
      const b = await popStrBuf()
      assert(typeof a === typeof b, 'concat type mismatch')
      if (typeof a === 'string') pushValue(a + b)
      else pushValue(Buffer.concat([a as Buffer, b as Buffer]))
    },
    async LOG_STACK() {
      const prefix = await popBuffer()
      let i = 0
      while (i < stack.length) {
        await db.doTransaction(async tn => {
          for (let k = 0; k < 100 && i < stack.length; k++) {
            const {instrId, data} = stack[i]
            let packedData = fdb.tuple.pack([
              await wrapP<TupleItem>(data)
            ])
            if (packedData.length > 40000) packedData = packedData.slice(0, 40000)

            // TODO: Would be way better here to use a tuple transaction.
            tn.set(Buffer.concat([prefix, fdb.tuple.pack([i, instrId])]), packedData)
            i++
          }
        })
      }
      stack.length = 0
    },

    // Transactions
    NEW_TRANSACTION() {
      transactions[tnNameKey()] = db.rawCreateTransaction()
      // transactions[tnNameKey()].setOption(fdb.TransactionOptionCode.TransactionLoggingEnable, Buffer.from(''+instrId))
    },
    async USE_TRANSACTION() {
      tnName = await popBuffer()
      console.log('using tn', tnName)
      if (transactions[tnNameKey()] == null) transactions[tnNameKey()] = db.rawCreateTransaction()
      // transactions[tnNameKey()].setOption(fdb.TransactionOptionCode.TransactionLoggingEnable, Buffer.from('x '+instrId))
    },
    async ON_ERROR(tn) {
      const code = Number(await popInt())
      pushValue(wrapP((<Transaction>tn).rawOnError(code)))
    },

    // Transaction read functions
    // async get(oper) {
    //   const key = await popBuffer()
    //   pushValue(await wrapP(oper.get(key)))
    // },
    async GET(oper) {
      const key = await popBuffer()
      pushValue(wrapP(oper.get(key)))
    },
    async GET_KEY(oper) {
      const keySel = await popSelector()
      const prefix = await popBuffer()

      const result = (await oper.getKey(keySel)) as Buffer
      // if (verbose) {
      //   console.log('get_key prefix', nodeUtil.inspect(prefix.toString('ascii')), result!.compare(prefix))
      //   console.log('get_key result', nodeUtil.inspect(result!.toString('ascii')), result!.compare(prefix))
      // }
      if (result!.equals(Buffer.from('RESULT_NOT_PRESENT'))) return result // Gross.

      // result starts with prefix.
      if (bufBeginsWith(result!, prefix)) pushValue(result)
      else if (result!.compare(prefix) < 0) pushValue(prefix) // RESULT < PREFIX
      else pushValue(util.strInc(prefix)) // RESULT > PREFIX
    },
    async GET_RANGE(oper) {
      const beginKey = await popBuffer()
      const endKey = await popBuffer()
      const limit = Number(await popInt())
      const reverse = await popBool()
      const streamingMode = await popInt() as StreamingMode
      // console.log('get range', instrId, beginKey, endKey, limit, reverse, 'mode', streamingMode, oper)
      
      const results = await oper.getRangeAll(
        keySelector.from(beginKey), keySelector.from(endKey),
        {streamingMode, limit, reverse}
      )
      // console.log('get range result', results)
      pushTupleItem(tuple.pack(Array.prototype.concat.apply([], results)))
    },
    async GET_RANGE_STARTS_WITH(oper) {
      const prefix = await popBuffer()
      const limit = Number(await popInt())
      const reverse = await popBool()
      const streamingMode = await popInt() as StreamingMode
      const results = await oper.getRangeAllStartsWith(prefix, {streamingMode, limit, reverse})
      pushValue(tuple.pack(Array.prototype.concat.apply([], results)))
    },
    async GET_RANGE_SELECTOR(oper) {
      const beginSel = await popSelector()
      const endSel = await popSelector()
      const limit = Number(await popInt())
      const reverse = await popBool()
      const streamingMode = await popInt() as StreamingMode
      const prefix = await popBuffer()

      const results = (await oper.getRangeAll(beginSel, endSel, {streamingMode, limit, reverse}))
        .filter(([k]) => bufBeginsWith(k as Buffer, prefix))

      pushValue(tuple.pack(Array.prototype.concat.apply([], results)))
    },
    async GET_READ_VERSION(oper) {
      try {
        lastVersion = await (<Transaction>oper).getReadVersion()
        pushLiteral("GOT_READ_VERSION")
      } catch (e) {
        pushValue(catchFdbErr(e))
      }
    },
    async GET_VERSIONSTAMP(oper) {
      pushValue(wrapP((<Transaction>oper).getVersionstamp().promise))
    },

    // Transaction set operations
    async SET(oper) {
      const key = await popStrBuf()
      const val = await popStrBuf()
      if (verbose) {
        console.log('SET', key, val)
        // const key2 = tuple.unpack(key as Buffer, true).map(v => Buffer.isBuffer(v) ? v.toString() : v)
        // if (key2[1] !== 'workspace') console.error('SET', key2, val)
      }
      maybePush(oper.set(key, val))
    },
    SET_READ_VERSION(oper) {
      ;(<Transaction>oper).setReadVersion(lastVersion)
    },
    async CLEAR(oper) {
      maybePush(oper.clear(await popStrBuf()))
    },
    async CLEAR_RANGE(oper) {
      maybePush(oper.clearRange(await popStrBuf(), await popStrBuf()))
    },
    async CLEAR_RANGE_STARTS_WITH(oper) {
      maybePush(oper.clearRangeStartsWith(await popStrBuf()))
    },
    async ATOMIC_OP(oper) {
      const codeStr = toUpperCamelCase(await popStr()) as keyof typeof MutationType
      const code: MutationType = MutationType[codeStr]
      assert(code, 'Could not find atomic codestr ' + codeStr)
      maybePush(oper.atomicOp(code, await popStrBuf(), await popStrBuf()))
    },
    async READ_CONFLICT_RANGE(oper) {
      ;(<Transaction>oper).addReadConflictRange(await popStrBuf(), await popStrBuf())
      pushLiteral("SET_CONFLICT_RANGE")
    },
    async WRITE_CONFLICT_RANGE(oper) {
      ;(<Transaction>oper).addWriteConflictRange(await popStrBuf(), await popStrBuf())
      pushLiteral("SET_CONFLICT_RANGE")
    },
    async READ_CONFLICT_KEY(oper) {
      ;(<Transaction>oper).addReadConflictKey(await popStrBuf())
      pushLiteral("SET_CONFLICT_KEY")
    },
    async WRITE_CONFLICT_KEY(oper) {
      ;(<Transaction>oper).addWriteConflictKey(await popStrBuf())
      pushLiteral("SET_CONFLICT_KEY")
    },
    DISABLE_WRITE_CONFLICT(oper) {
      ;(<Transaction>oper).setOption(TransactionOptionCode.NextWriteNoWriteConflictRange)
    },

    COMMIT(oper) {
      const i = instrId
      pushValue(wrapP((<Transaction>oper).rawCommit()))
    },
    RESET(oper) {(<Transaction>oper).rawReset()},
    CANCEL(oper) {(<Transaction>oper).rawCancel()},

    GET_COMMITTED_VERSION(oper) {
      lastVersion = (<Transaction>oper).getCommittedVersion()
      pushLiteral('GOT_COMMITTED_VERSION')
    },
    
    async GET_APPROXIMATE_SIZE(oper) {
      await (<Transaction>oper).getApproximateSize()
      pushLiteral('GOT_APPROXIMATE_SIZE')
    },

    async WAIT_FUTURE() {
      const f = stack[stack.length-1]!.data
      await f
    },


    // Tuple operations
    async TUPLE_PACK() {
      pushValue(tuple.pack(await popNValues()))
      // pushValue(shittyBake(tuple.pack(await popNValues())))
    },
    async TUPLE_PACK_WITH_VERSIONSTAMP() {
      const prefix = await popBuffer()
      // console.log('prefix', prefix.toString('hex'), prefix.length)
      try {
        const value = tuple.packUnboundVersionstamp(await popNValues())
        // console.log('a', value)
        // console.log('_', value.data.toString('hex'), value.data.length)
        // console.log('b', packPrefixedVersionStamp(prefix, value, true).toString('hex'))
        pushLiteral('OK')
        // pushValue(Buffer.concat([]))
        // pushValue(Buffer.concat([prefix, (value as UnboundStamp).data, ]))
        // const pack = packVersionStamp({data: Buffer.concat([prefix, value.data]), value.stampPos + prefix.length, true, false)
        const pack = packPrefixedVersionstamp(prefix, value, true)
        // console.log('packed', pack.toString('hex'))
        pushValue(pack)
      } catch (e) {
        // console.log('c', e)
        // TODO: Add userspace error codes to these.
        if (e.message === 'No incomplete versionstamp included in tuple pack with versionstamp') {
          pushLiteral('ERROR: NONE')
        } else if (e.message === 'Tuples may only contain 1 unset versionstamp') {
          pushLiteral('ERROR: MULTIPLE')
        } else throw e
      }
    },
    async TUPLE_UNPACK() {
      const packed = await popBuffer()
      for (const item of tuple.unpack(packed, true)) {
        // const pack = tuple.pack([item])
        // pushValue(isPackUnbound(pack) ? null : pack)
        pushValue(tuple.pack([item]))
      }
    },
    async TUPLE_RANGE() {
      const {begin, end} = tuple.range(await popNValues())
      pushValue(begin)
      pushValue(end)
    },
    async TUPLE_SORT() {
      // Look I'll be honest. I could put a compare function into the tuple
      // type, but it doesn't do anything you can't trivially do yourself.
      const items = (await popNValues())
        .map(buf => tuple.unpack(buf as Buffer, true))
        .sort((a: TupleItem[], b: TupleItem[]) => tuple.pack(a).compare(tuple.pack(b)))

      for (const item of items) pushValue(tuple.pack(item))
    },
    async ENCODE_FLOAT() {
      const buf = await popBuffer()
      // DataView avoids Buffer's canonicalization of NaN.
      const value = new DataView(buf.buffer).getFloat32(0, false)

      // console.log('bt encode_float', buf, value)
      // Could just pushValue({type: 'float', value})
      pushValue({type: 'float', value})
      // pushValue(tuple.unpack(tuple.pack([{type: 'float', value}]), true)[0])
      // pushTupleItem({type: 'float', value, rawEncoding: buf})
    },
    async ENCODE_DOUBLE() {
      const buf = await popBuffer()
      const value = new DataView(buf.buffer).getFloat64(0, false)
      // console.log('bt encode_double', buf, value)
      pushValue({type: 'double', value})
      // pushValue(tuple.unpack(tuple.pack([{type: 'double', value}]), true)[0])
      // pushTupleItem({type: 'double', value: 0, rawEncoding: buf})
    },
    async DECODE_FLOAT() {
      // These are both super gross. Not sure what to do about that.
      const val = await popValue() as {type: 'float', value: number, rawEncoding: Buffer}
      assert(typeof val === 'object' && val.type === 'float')

      const dv = new DataView(new ArrayBuffer(4))
      dv.setFloat32(0, val.value, false)
      // console.log('bt decode_float', val, Buffer.from(dv.buffer))
      pushValue(Buffer.from(dv.buffer))
      
      // const buf = Buffer.alloc(4)
      // buf.writeFloatBE(val.value, 0)
      // pushValue(buf)
      // pushValue(val.rawEncoding)
    },
    async DECODE_DOUBLE() {
      const val = await popValue() as {type: 'double', value: number, rawEncoding: Buffer}
      assert(val.type === 'double', 'val is ' + nodeUtil.inspect(val))

      const dv = new DataView(new ArrayBuffer(8))
      dv.setFloat64(0, val.value, false)
      pushValue(Buffer.from(dv.buffer))
      // console.log('bt decode_double', val, Buffer.from(dv.buffer))

      // const buf = Buffer.alloc(8)
      // buf.writeDoubleBE(val.value, 0)
      // pushValue(buf)
      // pushValue(val.rawEncoding)
    },

    // Thread Operations
    async START_THREAD() {
      // Note we don't wait here - this is run concurrently.
      const prefix = await popBuffer()
      runFromPrefix(db, prefix)
    },
    async WAIT_EMPTY() {
      const prefix = await popBuffer()
      await db.doTransaction(async tn => {
        const nextKey = (await tn.getKey(keySelector.firstGreaterOrEqual(prefix))) as Buffer
        if (nextKey && bufBeginsWith(nextKey, prefix)) {
          throw new fdb.FDBError('wait_empty', 1020)
        }
      }).catch(catchFdbErr)
      pushLiteral('WAITED_FOR_EMPTY')
    },

    // TODO: Invoke mocha here
    UNIT_TESTS() {},
  }

  return {
    async run(instrBuf: Buffer, log?: fs.WriteStream) {
      const instruction = fdb.tuple.unpack(instrBuf, true)
      let [opcode, ...oper] = instruction as [string, TupleItem[]]

      const txnOps = [
        'NEW_TRANSACTION',
        'USE_TRANSACTION',
        'ON_ERROR',
        'COMMIT',
        'CANCEL',
        'RESET',
      ]
      // if (verbose || (instrId > 25000 && instrId < 28523 && txnOps.includes(opcode))) {
      if (verbose) {
        if (oper.length) console.log(chalk.magenta(opcode as string), instrId, threadColor(initialName.toString('ascii')), oper, instrBuf.toString('hex'))
        else console.log(chalk.magenta(opcode as string), instrId, threadColor(initialName.toString('ascii')))
      }
      if (log) log.write(`${opcode} ${instrId} ${stack.length}\n`)

    
      let operand: Transaction | Database = transactions[tnNameKey()]
      if (opcode.endsWith('_SNAPSHOT')) {
        opcode = opcode.slice(0, -'_SNAPSHOT'.length)
        operand = (operand as Transaction).snapshot()
      } else if (opcode.endsWith('_DATABASE')) {
        opcode = opcode.slice(0, -'_DATABASE'.length)
        operand = db
      }

      // verbose = (instrId > 27234-10) && (instrId < 27234+10)
      // verbose = (instrId > 12700 && instrId < 12710) || (instrId > 12770 && instrId < 12788)

      try {
        await operations[opcode](operand, ...oper)
      } catch (e) {
        const err = catchFdbErr(e)
        pushValue(err)
      }

      if (verbose) {
        console.log(chalk.yellow('STATE'), instrId, threadColor(initialName.toString('ascii')), tnName.toString('ascii'), lastVersion)
        console.log(`stack length ${stack.length}:`)
        if (stack.length >= 1) console.log('  Stack top:', stack[stack.length-1].instrId, stack[stack.length-1].data)
        if (stack.length >= 2) console.log('  stack t-1:', stack[stack.length-2].instrId, stack[stack.length-2].data)
      }

      instrId++
    }
  }
}

const threads = new Set<Promise<void>>()
let instructionsRun = 0

const run = async (db: Database, prefix: Buffer, log?: fs.WriteStream) => {
  const machine = makeMachine(db, prefix)

  const {begin, end} = fdb.tuple.range([prefix])
  const instructions = await db.getRangeAll(begin, end)
  if (verbose) console.log(`Executing ${instructions.length} instructions from ${prefix.toString()}`)

  for (const [key, value] of instructions) {
    // console.log(key, value)
    await machine.run(value as Buffer, log)
    // TODO: consider inserting tiny sleeps to increase concurrency.
  }
  instructionsRun += instructions.length
  // console.log(`Thread ${prefix.toString()} complete`)
}

async function runFromPrefix(db: Database, prefix: Buffer, log?: fs.WriteStream) {
  const thread = run(db, prefix, log)

  threads.add(thread)
  await thread
  threads.delete(thread)
}

if (require.main === module) (async () => {
  process.on('unhandledRejection', (err: any) => {
    console.log(chalk.redBright('✖'), 'Unhandled error in binding tester:\n', err.message, 'code', err.code, err.stack)
    throw err
  })

  const prefixStr = process.argv[2]
  const requestedAPIVersion = +process.argv[3]
  const clusterFile = process.argv[4]

  // const log = fs.createWriteStream('nodetester.log')
  const log = undefined

  fdb.setAPIVersion(requestedAPIVersion)
  fdb.configNetwork({
    // trace_enable: 'trace',
    // external_client_library: '~/3rdparty/foundationdb/lib/libfdb_c.dylib-debug',
  })
  const db = fdb.open(clusterFile)

  runFromPrefix(db, Buffer.from(prefixStr, 'ascii'), log)

  // Wait until all 'threads' are finished.
  while (threads.size) {
    await Promise.all(Array.from(threads))
  }

  console.log(`${chalk.greenBright('✔')} Node binding tester complete. ${instructionsRun} commands executed`)

  // And wait for other threads! Logging won't work for concurrent runs.
  // if (log) log.end()
})()
