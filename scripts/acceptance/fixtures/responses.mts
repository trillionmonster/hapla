import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
/** A deterministic local Responses transport. Codex itself, its tools and its App Server remain real. */
export async function startResponsesFixture(observe: (value: object) => void) {
    const server = createServer(async (request, response) => {
        if (request.method === 'GET') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'gpt-5.4', object: 'model' }] })); return; }
        let bytes = ''; for await (const chunk of request) bytes += chunk;
        let input: any; try { input = JSON.parse(bytes); } catch { response.writeHead(400).end(); return; }
        const items = input.input ?? []; const lastUser = items.findLastIndex((item: any) => item.role === 'user');
        const latest = items[lastUser]; const text = typeof latest?.content === 'string' ? latest.content : JSON.stringify(latest?.content ?? '');
        const outputs = items.slice(lastUser + 1).filter((item: any) => item.type === 'function_call_output');
        const edit = text.includes('HAPLA_FIXTURE_EDIT'); const read = text.includes('HAPLA_FIXTURE_READ');
        const tool = (input.tools ?? []).find((candidate: any) => ['exec_command', 'shell_command', 'shell'].includes(candidate.name));
        observe({ type: 'provider-request', path: request.url, tools: (input.tools ?? []).map((t: any) => t.name).filter(Boolean), action: edit ? 'edit' : read ? 'read' : 'text', reasoning: input.reasoning, model: input.model, serviceTier: input.service_tier, auditMarker: text.match(/AUDIT_[A-Z_]+/)?.[0], toolOutputs: outputs.length, userMarkers: items.filter((item: any) => item.role === 'user').flatMap((item: any) => JSON.stringify(item.content).match(/HAPLA_FIXTURE_(?:EDIT|READ)/g) ?? []), observedOriginal: outputs.some((item: any) => String(item.output).includes('original')) });
        if (text.includes('AUDIT_HOLD')) await new Promise(resolve => setTimeout(resolve, 5000));
        const id = 'resp_' + randomUUID().replaceAll('-', '');
        let item: any;
        if ((edit || read) && outputs.length === 0 && tool) {
            const command = edit ? "printf 'fixture-native-edit\\n' > tracked.txt; printf 'fixture-new-file\\n' > native-new.txt" : 'cat tracked.txt';
            const fields = tool.parameters?.properties ?? {};
            const args = 'cmd' in fields ? { cmd: command } : { command: fields.command?.type === 'array' ? ['bash', '-lc', command] : command };
            item = { id: 'fc_' + randomUUID().replaceAll('-', ''), type: 'function_call', call_id: 'call_' + randomUUID(), name: tool.name, arguments: JSON.stringify(args), status: 'completed' };
        } else {
            item = { id: 'msg_' + randomUUID().replaceAll('-', ''), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: edit || read ? 'HAPLA_FIXTURE_DONE' : 'Coding acceptance', annotations: [] }] };
        }
        const completed = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: input.model ?? 'gpt-5.4', output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 } } };
        if (!input.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(completed)); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); let sequence = 0;
        const event = (type: string, fields: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
        event('response.created', { response: { ...completed, status: 'in_progress', output: [] } });
        event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
        if (item.type === 'function_call') {
            event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
            event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments });
        } else {
            const part = item.content[0];
            event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } });
            event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: part.text });
            event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: part.text });
            event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part });
        }
        event('response.output_item.done', { output_index: 0, item });
        event('response.completed', { response: completed }); response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not listen.');
    return { url: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
