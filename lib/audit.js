const hypercoreCrypto = require('hypercore-crypto')
const flat = require('flat-tree')
const b4a = require('b4a')

const BitInterlude = require('./bit-interlude')

// this is optimised for speed over mem atm
// can be tweaked in the future

module.exports = async function auditCore (core, storage) {
  const corrections = {
    tree: 0,
    blocks: 0
  }

  const length = core.header.tree.length

  const bitfield = new BitInterlude()

  const data = await readAllBlocks(core.storage)
  const tree = await readAllTreeNodes(core.tree.storage)

  const valid = new Uint8Array(Math.ceil(tree.byteLength / 40))
  const stack = []

  for (const r of core.tree.roots) {
    valid[r.index] = 1
    stack.push(r)
  }

  while (stack.length > 0) {
    const node = stack.pop()
    if ((node.index & 1) === 0) continue

    const [left, right] = flat.children(node.index)
    const leftNode = tree.get(left)
    const rightNode = tree.get(right)

    if (!rightNode && !leftNode) continue

    stack.push(leftNode, rightNode)

    if (valid[node.index]) {
      const hash = hypercoreCrypto.parent(leftNode, rightNode)
      if (b4a.equals(hash, node.hash) && node.size === (leftNode.size + rightNode.size)) {
        valid[leftNode.index] = 1
        valid[rightNode.index] = 1
        continue
      }
    }

    if (leftNode.size) clearNode(left)
    if (rightNode.size) clearNode(right)
  }

  let i = 0
  let nextOffset = -1
  while (i < length) {
    const has = core.bitfield.get(i)

    if (!has) {
      if (i + 1 === length) break
      i = core.bitfield.findFirst(true, i + 1)
      if (i < 0) break
      nextOffset = -1
      continue
    }

    if (nextOffset === -1) {
      try {
        nextOffset = await core.tree.byteOffset(i * 2)
      } catch {
        storage.deleteBlock(i)
        bitfield.set(i, false)
        corrections.blocks++
        i++
        continue
      }
    }

    const node = tree.get(i * 2)
    const blk = data.get(i)
    const hash = hypercoreCrypto.data(blk)

    nextOffset += blk.byteLength

    if (!b4a.equals(hash, node.hash)) {
      storage.deleteBlock(i)
      bitfield.set(i, false)
      corrections.blocks++
    }

    i++
  }

  bitfield.flush(storage, core.bitfield)

  return corrections

  function clearNode (node) {
    valid[node.index] = 0
    storage.deleteTreeNode(node.index)
    corrections.tree++
  }
}

async function readAllBlocks (storage) {
  const data = new Map()
  for await (const block of storage.createBlockStream()) {
    data.set(block.index, block.value)
  }
  return data
}

async function readAllTreeNodes (storage) {
  const nodes = new Map()
  for await (const node of storage.createTreeNodeStream()) {
    nodes.set(node.index, node)
  }
  return nodes
}
