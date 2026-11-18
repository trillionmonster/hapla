#!/usr/bin/env node
/** Summarize Unistyles DOM retainers without printing snapshot strings or test-account data. */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/acceptance/analyze-session-cache-heap.mjs <private.heapsnapshot>');
const heap = JSON.parse(readFileSync(path, 'utf8'));
const { nodes, edges, strings, snapshot: { meta } } = heap;
const fields = meta.node_fields, edgeFields = meta.edge_fields;
const stride = fields.length, edgeStride = edgeFields.length;
const name = fields.indexOf('name'), type = fields.indexOf('type');
const count = fields.indexOf('edge_count'), detached = fields.indexOf('detachedness');
const edgeType = edgeFields.indexOf('type'), label = edgeFields.indexOf('name_or_index'), target = edgeFields.indexOf('to_node');
const edgeTypes = meta.edge_types[edgeType], nodeTypes = meta.node_types[type];
const starts = new Uint32Array(nodes.length / stride), counters = [];
let offset = 0;
for (let node = 0; node < nodes.length; node += stride) {
    starts[node / stride] = offset;
    for (let edge = offset; edge < offset + nodes[node + count] * edgeStride; edge += edgeStride) {
        if (edgeTypes[edges[edge + edgeType]] === 'property' && strings[edges[edge + label]] === 'stylesCounter') counters.push(edges[edge + target]);
    }
    offset += nodes[node + count] * edgeStride;
}
function outgoing(node) {
    const result = [];
    for (let edge = starts[node / stride]; edge < starts[node / stride] + nodes[node + count] * edgeStride; edge += edgeStride) {
        const kind = edgeTypes[edges[edge + edgeType]];
        if (kind === 'weak') continue;
        result.push({ kind, label: ['element', 'hidden'].includes(kind) ? edges[edge + label] : strings[edges[edge + label]], target: edges[edge + target] });
    }
    return result;
}
const table = (node) => outgoing(node).find(edge => edge.label === 'table')?.target;
let sets = 0;
const nativeNodes = new Set();
for (const counter of counters) {
    const mapTable = table(counter);
    if (mapTable === undefined) continue;
    for (const edge of outgoing(mapTable)) {
        if (strings[nodes[edge.target + name]] !== 'Set') continue;
        sets++;
        const setTable = table(edge.target);
        if (setTable === undefined) continue;
        for (const member of outgoing(setTable)) {
            if (nodeTypes[nodes[member.target + type]] === 'native') nativeNodes.add(member.target);
        }
    }
}
console.log(JSON.stringify({
    retainerPath: 'UnistylesRegistry.stylesCounter → Map → Set → native DOM',
    registries: counters.length, styleSets: sets, retainedNativeNodes: nativeNodes.size,
    detachedNativeNodes: [...nativeNodes].filter(node => detached >= 0 && nodes[node + detached] === 2).length,
}, null, 2));
