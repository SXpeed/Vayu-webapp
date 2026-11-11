// Social → WhatsApp and email invites against a real local Worker and a
// stand-in for MSG91: connecting a workspace's own account, templates (every
// header and button kind) and their review, sending to tagged contacts with
// each person's name, delivery reports, RSVP, STOP and unsubscribe, the
// invite's file, and that none of it crosses workspaces or reaches people
// without the Social permission.
//
//   node --test frontend/tests/social.integration.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';
import { load } from './helpers/load.mjs';

const rules = await load('socialRules.ts');
const USER_PASSWORD = 'member password 123';
const GOOD_KEY = 'msg91-auth-key-of-studio-a';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

let worker;
let msg91;
let ownerA;
let staffA;
let ownerB;
let orgA;
let orgB;
/** What the stand-in MSG91 was asked, and what it says about templates. */
const calls = [];
const review = new Map();
/** Templates made in MSG91's own panel, in the shape its list really has (taken from a live account, 2026-11-11). */
const panelLanguage = (name, extra = {}) => ({
    name, language: 'en', parameter_format: 'POSITIONAL', status: 'approved', rejection_reason: 'NONE', is_disabled: 0,
    variables: ['header_1', 'body_1', 'body_2'], variable_type: { header_1: { type: 'image' }, body_1: { type: 'text' }, body_2: { type: 'text' } },
    code: [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://x.example/p.png'] } }, { type: 'BODY', text: 'Warm greetings, {{1}}.\n\nYour order {{2}} is confirmed.' }, { type: 'FOOTER', text: 'Vayu' }],
    ...extra,
});
const panelTemplates = [
    { name: 'order_confirmed', namespace: 'ns_1', languages: [panelLanguage('order_confirmed')] },
    { name: 'video_promo', namespace: 'ns_1', languages: [panelLanguage('video_promo', {
        variables: ['header_1', 'body_1', 'body_2', 'button_2'], variable_type: { header_1: { type: 'video' } },
        code: [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'Hi {{1}}, watch {{2}}.' },
            { type: 'BUTTONS', buttons: [{ type: 'PHONE_NUMBER', text: 'Call', phone_number: '+911234567890' }, { type: 'URL', text: 'Watch', url: 'https://x.example/v/{{1}}' }] }],
    })] },
    { name: 'login_code', category: 'AUTHENTICATION', namespace: 'ns_1', languages: [panelLanguage('login_code')] },
];
/** Email templates MSG91 holds, by slug. */
const emailTemplates = new Map();

const app = (org, path) => `/api/o/${org.id}${path}`;
const post = (b, path, body = {}) => b.call(path, { method: 'POST', body });

async function upload(b, org) {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'poster.png');
    const res = await fetch(`${worker.origin}${app(org, '/upload')}`, {
        method: 'POST', body: form, headers: { Cookie: [...b.jar].map(([k, v]) => `${k}=${v}`).join('; '), Origin: worker.origin },
    });
    assert.equal(res.status, 200);
    return (await res.json()).url;
}

async function report(hookUrl, payload) {
    const res = await fetch(`${worker.origin}${new URL(hookUrl).pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return res.status;
}

async function until(check, what) {
    for (let i = 0; i < 50; i++) {
        const got = await check();
        if (got) return got;
        await new Promise(r => setTimeout(r, 200));
    }
    assert.fail(`Timed out waiting for ${what}`);
}

before(async () => {
    msg91 = createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null;
            calls.push({ method: req.method, path: req.url, key: req.headers.authkey, body });
            const answer = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
            if (req.headers.authkey !== GOOD_KEY) return answer(401, { status: 'fail', hasError: true, errors: 'Unauthorized', code: '401' });
            if (req.url.endsWith('/whatsapp-activation/')) return answer(200, { status: 'success', hasError: false, data: [{ integrated_number: '919800000001' }] });
            if (req.url.includes('/get-template-client/')) {
                return answer(200, { status: 'success', hasError: false, data: [...panelTemplates, ...[...review].map(([name, status]) => ({ name, namespace: 'ns_1', languages: [{ language: 'en', status, rejection_reason: 'NONE' }] }))] });
            }
            if (req.url.endsWith('/client-panel-template/')) { review.set(body.template_name, 'PENDING'); return answer(200, { status: 'success', hasError: false, data: { template_id: '1' } }); }
            if (req.method === 'POST' && req.url.endsWith('/email/templates')) {
                const slug = `${body.slug}_7`;
                emailTemplates.set(slug, 1);
                return answer(200, { status: 'success', hasError: false, data: { id: 1, slug, versions: [{ slug, status_id: 1 }] } });
            }
            if (req.url.startsWith('/api/v5/email/templates')) {
                return answer(200, { status: 'success', hasError: false, data: { data: [...emailTemplates].map(([slug, status]) => ({ slug, versions: [{ is_active: true, status_id: status }] })) } });
            }
            if (req.url.endsWith('/email/send')) return answer(200, { status: 'success', hasError: false, data: { unique_id: `u_${calls.length}` }, message: 'queued' });
            return answer(200, { status: 'success', hasError: false, request_id: `req_${calls.length}` });
        });
    });
    await new Promise(r => msg91.listen(0, '127.0.0.1', r));
    worker = await startDevWorker({ vars: { MSG91_API_BASE: `http://127.0.0.1:${msg91.address().port}` } });
    const admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', 'provider-admin-password')).status, 200);
    for (const [email, name] of [['owner-a@example.com', 'Roshni Shah'], ['staff-a@example.com', 'Staff A'], ['owner-b@example.com', 'Owner B']]) {
        assert.equal((await post(admin, '/admin/users', { email, name, temporaryPassword: USER_PASSWORD })).status, 201);
    }
    orgA = (await post(admin, '/admin/orgs', { name: 'Studio A', businessType: 'studio', ownerEmail: 'owner-a@example.com' })).body;
    orgB = (await post(admin, '/admin/orgs', { name: 'Gallery B', businessType: 'gallery', ownerEmail: 'owner-b@example.com' })).body;
    assert.equal((await post(admin, `/admin/orgs/${orgA.id}/members`, { email: 'staff-a@example.com', role: 'staff' })).status, 201);
    ownerA = worker.browser(); staffA = worker.browser(); ownerB = worker.browser();
    for (const [b, email] of [[ownerA, 'owner-a@example.com'], [staffA, 'staff-a@example.com'], [ownerB, 'owner-b@example.com']]) {
        assert.equal((await b.signIn(email, USER_PASSWORD)).status, 200, email);
    }
});

after(async () => { await worker?.stop(); worker?.cleanup(); msg91?.close(); });

const template = {
    channel: 'whatsapp', name: 'opening_invite', language: 'en', category: 'MARKETING', header: 'none', headerText: '',
    body: 'Hello {{name}}, you are invited to {{event}} on {{date}}. We hope to see you.', footer: 'Reply STOP to opt out', buttons: rules.RSVP_BUTTONS, samples: {},
};

test('the rules: templates, names, what MSG91 is sent and what its reports mean', () => {
    assert.deepEqual(rules.parseTemplate(template), template);
    assert.deepEqual(rules.templateFields(template.body), ['name', 'event', 'date']);
    assert.equal(rules.numberedBody('Hi {{ name }}, {{event}} again for {{name}}.'), 'Hi {{1}}, {{2}} again for {{1}}.');
    assert.equal(rules.templateSlug('  Monsoon Show — Opening! '), 'monsoon_show_opening');
    for (const bad of [
        { name: 'Opening Invite' }, { name: 'ab' }, { language: 'xx' }, { body: 'short' }, { body: '{{name}}, you are invited to the show.' },
        { body: 'You are invited to the show, {{name}}' }, { body: 'Hello {{name}}{{event}} is on, do come.' }, { body: 'Hello {{surname}}, do come to the show.' },
        { body: `Hello ${'x'.repeat(1030)}` }, { footer: 'x'.repeat(61) }, { footer: 'For {{name}}' }, { header: 'text', headerText: '' },
        { header: 'text', headerText: '{{event}} and {{date}}' }, { buttons: [{ kind: 'url', text: 'A', url: 'https://a.in/{{x}}/b' }] },
        { buttons: [1, 2, 3].map(() => ({ kind: 'url', text: 'Site', url: 'https://a.in' })) }, { buttons: [{ kind: 'phone', text: 'Call', phone: '98765' }] },
        { buttons: [{ kind: 'quick_reply', text: 'x'.repeat(26) }] }, { buttons: [{ kind: 'copy_code', text: 'TOO LONG CODE!!!' }] },
    ]) assert.ok('problem' in rules.parseTemplate({ ...template, ...bad }), JSON.stringify(bad).slice(0, 80));
    // Your own fields, with an example for each; quick replies are put before the other buttons.
    const rich = rules.parseTemplate({
        ...template, category: 'UTILITY', header: 'text', headerText: 'Invite: {{event}}', body: 'Hello {{name}}, use *{{offer}}* at {{venue}}.',
        buttons: [{ kind: 'url', text: 'RSVP', url: 'https://vayu.in/r/{{guest_code}}' }, { kind: 'quick_reply', text: 'Yes' }, { kind: 'phone', text: 'Call', phone: '+91 98765 43210' }, { kind: 'copy_code', text: 'VAYU20' }],
        samples: { offer: '20% off', guest_code: 'AB12', stray: 'dropped' },
    });
    assert.deepEqual(rich.samples, { offer: '20% off', guest_code: 'AB12' });
    assert.deepEqual(rich.buttons.map(b => b.kind), ['quick_reply', 'url', 'phone', 'copy_code']);
    assert.ok('problem' in rules.parseTemplate({ ...rich, samples: {} }));
    const richPayload = rules.createTemplatePayload('91', rich, '');
    assert.deepEqual(richPayload.category, 'UTILITY');
    assert.deepEqual(richPayload.components[0], { type: 'HEADER', format: 'TEXT', text: 'Invite: {{1}}', example: { header_text: ['Monsoon Show'] } });
    assert.deepEqual(richPayload.components.at(-1).buttons, [
        { type: 'QUICK_REPLY', text: 'Yes' }, { type: 'URL', text: 'RSVP', url: 'https://vayu.in/r/{{1}}', example: ['https://vayu.in/r/AB12'] },
        { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+919876543210' }, { type: 'COPY_CODE', example: 'VAYU20' },
    ]);
    assert.deepEqual(rules.sendSlots(rich).map(s => s.key), ['event', 'offer', 'venue', 'button_2', 'button_4']);
    const richSent = rules.sendPayload({ number: '91', template: rich, namespace: '', imageUrl: '', recipients: [{ id: 'r', phone: '91', name: 'Anjali' }],
        values: { event: 'Show', offer: '10%', venue: 'Vayu', button_2: 'AN1', button_4: 'CODE9' } }).payload.template.to_and_components[0].components;
    assert.deepEqual([richSent.header_1, richSent.button_2, richSent.button_4.value], [{ type: 'text', value: 'Show' }, { subtype: 'url', type: 'text', value: 'AN1' }, 'CODE9']);
    assert.match(rules.inviteProblem({ ...template, header: 'location' }, { event: 'x', date: 'y', location_name: 'G', location_address: 'A', location_lat: 'north', location_lng: '72' }, ''), /latitude/);

    assert.deepEqual(['Anjali Mehta', ' dr. Mehta ', 'Mrs Rao', '', 'Kabir'].map(rules.firstName), ['Anjali', 'dr. Mehta', 'Mrs Rao', 'there', 'Kabir']);

    const created = rules.createTemplatePayload('919800000001', { ...template, header: 'image' }, 'https://x.example/p.png');
    assert.deepEqual(created.components.map(c => c.type), ['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
    assert.equal(created.components[1].text, 'Hello {{1}}, you are invited to {{2}} on {{3}}. We hope to see you.');
    assert.deepEqual(created.components[1].example.body_text, [['Anjali', 'Monsoon Show', '14 Nov, 6 pm']]);

    const sent = rules.sendPayload({
        number: '919800000001', template: { ...template, header: 'image' }, namespace: 'ns_1', values: { event: 'Monsoon Show', date: '14 Nov' }, imageUrl: 'https://x.example/p.png',
        recipients: [{ id: 'r_1', phone: '919811111111', name: 'Anjali Mehta' }, { id: 'r_2', phone: '919822222222', name: '' }],
    });
    const [one, two] = sent.payload.template.to_and_components;
    assert.deepEqual([one.to, one.CRQID, one.components.body_1.value, one.components.body_2.value, one.components.header_1], [['919811111111'], 'r_1', 'Anjali', 'Monsoon Show', { type: 'image', value: 'https://x.example/p.png' }]);
    assert.equal(two.components.body_1.value, 'there');
    // A template from MSG91's panel: its own numbers, and {{name}} in a typed value is each person's name.
    const numbered = rules.sendPayload({
        number: '1', template: { name: 'order', language: 'en', body: 'Order {{2}} for {{1}}, thank you {{1}}.', header: 'none', headerText: '', buttons: [] }, namespace: '', values: { 1: 'Dear {{name}}', 2: '#1072' }, imageUrl: '',
        recipients: [{ id: 'r', phone: '919811111111', name: 'Anjali Mehta' }],
    }).payload.template.to_and_components[0].components;
    assert.deepEqual([numbered.body_1.value, numbered.body_2.value], ['Dear Anjali', '#1072']);
    assert.equal(rules.filledBody('Order {{2}} for {{1}}.', { 1: '{{name}}', name: 'Anjali' }), 'Order {{2}} for Anjali.');
    assert.equal(rules.inviteProblem({ ...template, body: 'Order {{2}} for {{1}}.', buttons: [] }, { 1: '{{name}}' }, ''), 'Fill in "field 2".');
    assert.ok('problem' in rules.parseTemplate({ ...template, body: 'Hello {{1}}, do come to the show.' })); // numbers are MSG91's, not typed here
    assert.equal(rules.inviteProblem(template, { event: 'Show' }, ''), 'Fill in "date".');
    assert.match(rules.inviteProblem({ ...template, header: 'image' }, { event: 'Show', date: 'x' }, ''), /picture/);

    // Reports only move a person forward, whatever order they arrive in.
    assert.equal(rules.nextStatus('read', 'delivered'), 'read');
    assert.equal(rules.nextStatus('submitted', 'delivered'), 'delivered');
    assert.equal(rules.nextStatus('delivered', 'failed'), 'delivered');
    assert.equal(rules.nextStatus('submitted', 'failed'), 'failed');
    assert.equal(rules.nextStatus('failed', 'sent'), 'failed');
    assert.deepEqual(rules.parseWebhook({ eventName: 'delivered', customerNumber: '919811111111', crqid: 'r_1', requestId: 'q' }),
        { kind: 'status', phone: '919811111111', status: 'delivered', id: 'r_1', requestId: 'q', reason: '' });
    assert.equal(rules.parseWebhook({ status: 'Failed', customer_number: '+91 98111 11111', reason: '131049 not delivered' }).reason, '131049 not delivered');
    assert.deepEqual(rules.parseWebhook({ direction: 0, customerNumber: '919811111111', button: '{"payload":"x","text":"Yes, I’ll come"}' }), { kind: 'reply', phone: '919811111111', text: 'Yes, I’ll come' });
    assert.equal(rules.parseWebhook({ eventName: 'request received', customerNumber: '919811111111' }), null);
    assert.equal(rules.parseWebhook(null), null);
    assert.deepEqual(['Yes, I’ll come', "Can't make it", 'YES please', 'maybe'].map(rules.rsvpOf), ['yes', 'no', 'yes', '']);
    assert.ok(rules.isStop(' Stop ') && !rules.isStop('Do not stop'));
    assert.equal(rules.reached({ ...rules.emptyCounts(), sent: 1, delivered: 2, read: 3 }, 'delivered'), 5);
    // Email reports: by the address; unsubscribes stop further email.
    assert.deepEqual(rules.parseWebhook({ eventName: 'Opened', recipient: 'A@x.in', requestId: 'u_1', crqid: '' }), { kind: 'status', phone: 'a@x.in', status: 'read', id: '', requestId: 'u_1', reason: '' });
    assert.deepEqual(rules.parseWebhook({ eventName: 'Unsubscribed', recipient: 'a@x.in' }), { kind: 'stop', phone: 'a@x.in' });
    assert.equal(rules.parseWebhook({ eventName: 'Failed', recipient: 'a@x.in', reason: '550 no such user' }).reason, '550 no such user');
    const html = rules.emailHtml({ header: 'image', body: 'Hello {{name}},\n\nSee <you>.', buttons: rules.RSVP_BUTTONS }, 'Vayu & Co');
    assert.ok(html.includes('{{image_url}}') && html.includes('{{rsvp_yes_url}}') && html.includes('{{unsubscribe_url}}') && html.includes('See &lt;you&gt;.') && html.includes('Vayu &amp; Co'));
});

test('an admin connects the workspace’s own MSG91 account; the key is never shown again', async () => {
    assert.equal((await ownerA.call(app(orgA, '/social/whatsapp'))).body.connected, false);
    const put = body => ownerA.call(app(orgA, '/social/whatsapp'), { method: 'PUT', body });
    assert.equal((await put({ authKey: 'x', number: '919800000001' })).status, 400);
    const wrongNumber = await put({ authKey: GOOD_KEY, number: '919811111111' });
    assert.equal(wrongNumber.status, 409);
    assert.match(wrongNumber.body.error, /number is \+919800000001/);
    const refused = await put({ authKey: 'a-key-msg91-does-not-know', number: '919800000001' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /IP security/);
    const ok = await put({ authKey: GOOD_KEY, number: '+91 98000 00001' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.number, '919800000001');
    assert.match(ok.body.webhookUrl, new RegExp(`/api/v2/webhooks/msg91/${orgA.id}/[a-f0-9]{48}$`));
    // No number given: the account's own. No key given: the saved one is kept.
    assert.equal((await put({})).body.number, '919800000001');
    const seen = await ownerA.call(app(orgA, '/social/whatsapp'));
    assert.ok(!seen.text.includes(GOOD_KEY));
    assert.equal(seen.body.webhookUrl, ok.body.webhookUrl);
});

test('Social is closed to a role without it, and to other workspaces', async () => {
    for (const path of ['/social/whatsapp', '/social/templates', '/social/invites']) {
        assert.equal((await staffA.call(app(orgA, path))).status, 403, path);
        assert.equal((await ownerB.call(app(orgA, path))).status, 404, path);
    }
    assert.equal((await post(staffA, app(orgA, '/social/invites'), {})).status, 403);
    assert.equal((await ownerB.call(app(orgB, '/social/whatsapp'))).body.connected, false);
    assert.equal((await post(ownerB, app(orgB, '/social/templates'), template)).status, 409); // not connected
});

let hookUrl;
let templateId;
let tagId;

test('a template is sent for review, and can be used once Meta approves it', async () => {
    assert.equal((await post(ownerA, app(orgA, '/social/templates'), { ...template, body: '{{name}} come' })).status, 400);
    const made = await post(ownerA, app(orgA, '/social/templates'), template);
    assert.equal(made.status, 201, made.text);
    assert.equal(made.body.status, 'pending');
    templateId = made.body.id;
    const sentToMsg91 = calls.findLast(c => c.path.endsWith('/client-panel-template/')).body;
    assert.deepEqual([sentToMsg91.integrated_number, sentToMsg91.template_name, sentToMsg91.category], ['919800000001', 'opening_invite', 'MARKETING']);
    assert.equal((await post(ownerA, app(orgA, '/social/templates'), template)).status, 409); // same name

    tagId = (await post(ownerA, app(orgA, '/contact-tags'), { name: 'WhatsApp OK', color: '' })).body.id;
    const invite = { name: 'Opening', templateId, tagIds: [tagId], values: { event: 'Monsoon Show', date: '14 Nov, 6 pm' } };
    assert.equal((await post(ownerA, app(orgA, '/social/invites'), invite)).status, 409); // not approved yet

    review.set('opening_invite', 'APPROVED');
    const list = await ownerA.call(app(orgA, '/social/templates?refresh=1'));
    const mine = list.body.templates.find(t => t.id === templateId);
    assert.deepEqual([list.body.checked, mine.status], [true, 'approved']);

    // Templates made in MSG91's own panel come in too (any header, buttons with a field); a one-time-password one is counted, not listed.
    const panel = list.body.templates.find(t => t.name === 'order_confirmed');
    assert.deepEqual([panel.status, panel.header, panel.footer, panel.body, list.body.skipped], ['approved', 'image', 'Vayu', 'Warm greetings, {{1}}.\n\nYour order {{2}} is confirmed.', 1]);
    const video = list.body.templates.find(t => t.name === 'video_promo');
    assert.deepEqual([video.header, video.buttons.map(b => b.kind), rules.sendSlots(video).map(s => s.key)], ['video', ['phone', 'url'], ['1', '2', 'button_2']]);
    assert.ok(!list.body.templates.some(t => t.name === 'login_code'));
    assert.equal((await ownerA.call(app(orgA, '/social/templates?refresh=1'))).body.templates.length, list.body.templates.length); // not brought in twice
});

test('an invite goes to each tagged contact once, with their own name, and reports move them along', async () => {
    const contact = (id, name, phones, tags = [tagId]) => post(ownerA, app(orgA, '/contacts'), { id, name, phones, emails: [], tags, notes: '' });
    for (const res of [
        await contact('c1', 'Anjali Mehta', ['98111 11111']), await contact('c2', 'Dr. Rao', ['+919822222222']),
        await contact('c3', 'No Phone', []), await contact('c4', 'Not Tagged', ['9833333333'], []),
    ]) assert.ok(res.status < 300, res.text);

    const reach = await ownerA.call(app(orgA, `/social/audience?tags=${tagId}`));
    assert.deepEqual([reach.body.total, reach.body.reachable], [3, 2]);

    const invite = { name: 'Opening', templateId, tagIds: [tagId], values: { event: 'Monsoon Show', date: '14 Nov, 6 pm' } };
    assert.equal((await post(ownerA, app(orgA, '/social/invites'), { ...invite, values: { event: 'Monsoon Show' } })).status, 400);
    assert.equal((await post(ownerA, app(orgA, '/social/invites'), { ...invite, tagIds: [] })).status, 400);
    const made = await post(ownerA, app(orgA, '/social/invites'), invite);
    assert.equal(made.status, 201, made.text);
    assert.equal(made.body.counts.total, 2);

    const detail = () => ownerA.call(app(orgA, `/social/invites/${made.body.id}`));
    const sent = await until(async () => { const d = await detail(); return d.body.invite.status === 'sent' && d; }, 'the invite to be sent');
    assert.deepEqual(sent.body.recipients.map(r => [r.name, r.phone, r.status]), [['Anjali Mehta', '919811111111', 'submitted'], ['Dr. Rao', '919822222222', 'submitted']]);
    const bulk = calls.filter(c => c.path.endsWith('/whatsapp-outbound-message/bulk/'));
    assert.equal(bulk.length, 1);
    const t = bulk[0].body.payload.template;
    assert.deepEqual([bulk[0].body.integrated_number, t.name, t.namespace], ['919800000001', 'opening_invite', 'ns_1']);
    assert.deepEqual(t.to_and_components.map(e => [e.to[0], e.components.body_1.value, e.components.body_2.value]),
        [['919811111111', 'Anjali', 'Monsoon Show'], ['919822222222', 'Dr. Rao', 'Monsoon Show']]);

    hookUrl = (await ownerA.call(app(orgA, '/social/whatsapp'))).body.webhookUrl;
    const [anjali, rao] = sent.body.recipients;
    assert.equal(await report(hookUrl.replace(/[a-f0-9]{48}$/, 'a'.repeat(48)), { eventName: 'read', customerNumber: anjali.phone, crqid: anjali.id }), 404);
    for (const payload of [
        { eventName: 'delivered', customerNumber: anjali.phone, crqid: anjali.id },
        { eventName: 'read', customerNumber: anjali.phone, crqid: anjali.id },
        { eventName: 'sent', customerNumber: anjali.phone, crqid: anjali.id }, // late: changes nothing
        { eventName: 'failed', customerNumber: rao.phone, requestId: 'req_unknown', reason: 'ignored: no such request' },
        { status: 'Failed', customer_number: rao.phone, request_id: bulk[0] && `req_${calls.indexOf(bulk[0]) + 1}`, reason: '131026 not on WhatsApp' },
        { direction: 0, customerNumber: anjali.phone, button: { payload: 'yes', text: 'Yes, I’ll come' } },
        { something: 'else' },
    ]) assert.equal(await report(hookUrl, payload), 200);

    const after = (await detail()).body;
    assert.deepEqual(after.recipients.map(r => [r.status, r.rsvp, r.reason]), [['read', 'yes', ''], ['failed', '', '131026 not on WhatsApp']]);
    assert.deepEqual([after.invite.counts.read, after.invite.counts.failed, after.invite.counts.yes], [1, 1, 1]);
    assert.equal((await ownerA.call(app(orgA, '/social/invites'))).body.invites[0].counts.total, 2);
    assert.deepEqual((await ownerB.call(app(orgB, '/social/invites'))).body.invites, []);
});

test('someone who replies STOP is left out from then on', async () => {
    assert.equal(await report(hookUrl, { direction: 'inbound', customerNumber: '919811111111', text: 'STOP' }), 200);
    const reach = await ownerA.call(app(orgA, `/social/audience?tags=${tagId}`));
    assert.deepEqual([reach.body.reachable, reach.body.optedOut], [1, 1]);
});

test('a test goes to one number; an invite’s picture is public only with its signature', async () => {
    const image = await upload(ownerA, orgA);
    const withPicture = { ...template, name: 'poster_invite', header: 'image' };
    assert.equal((await post(ownerA, app(orgA, '/social/templates'), withPicture)).status, 400); // no sample picture
    const made = await post(ownerA, app(orgA, '/social/templates'), { ...withPicture, sampleImageUrl: image });
    assert.equal(made.status, 201, made.text);
    review.set('poster_invite', 'APPROVED');
    await ownerA.call(app(orgA, '/social/templates?refresh=1'));

    const body = { templateId: made.body.id, values: { event: 'Monsoon Show', date: '14 Nov' }, phone: '98444 44444' };
    assert.equal((await post(ownerA, app(orgA, '/social/test'), body)).status, 400); // the picture is missing
    const before = calls.length;
    assert.equal((await post(ownerA, app(orgA, '/social/test'), { ...body, imageUrl: image })).status, 200);
    const entry = calls[before].body.payload.template.to_and_components[0];
    assert.deepEqual([entry.to, entry.components.body_1.value], [['919844444444'], 'Roshni']);

    const publicUrl = new URL(entry.components.header_1.value);
    const fetched = await fetch(`${worker.origin}${publicUrl.pathname}`);
    assert.deepEqual([fetched.status, fetched.headers.get('content-type')], [200, 'image/png']);
    const forged = publicUrl.pathname.replace(/\/[a-f0-9]{32}\//, `/${'0'.repeat(32)}/`);
    assert.equal((await fetch(`${worker.origin}${forged}`)).status, 404);
    assert.equal((await fetch(`${worker.origin}${publicUrl.pathname.replace(orgA.id, orgB.id)}`)).status, 404);
});

test('an invite with a send time waits, then the scheduled job sends it', async () => {
    const bulk = () => calls.filter(c => c.path.endsWith('/whatsapp-outbound-message/bulk/')).length;
    const before = bulk();
    const made = await post(ownerA, app(orgA, '/social/invites'), {
        name: 'Reminder', templateId, tagIds: [tagId], values: { event: 'Monsoon Show', date: 'tomorrow' }, sendAt: Date.now() + 1500,
    });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.body.status, 'scheduled');
    const cron = () => fetch(`${worker.origin}/__scheduled?cron=*/10+*+*+*+*`);
    await cron();
    await new Promise(r => setTimeout(r, 500));
    assert.equal(bulk(), before); // not time yet
    await new Promise(r => setTimeout(r, 1200));
    await cron();
    const sent = await until(async () => {
        const d = await ownerA.call(app(orgA, `/social/invites/${made.body.id}`));
        return d.body.invite.status === 'sent' && d;
    }, 'the scheduled invite to be sent');
    assert.deepEqual(sent.body.recipients.map(r => r.name), ['Dr. Rao']); // Anjali replied STOP
    assert.equal(bulk(), before + 1);
    await cron(); // nothing left: it is not sent twice
    await new Promise(r => setTimeout(r, 500));
    assert.equal(bulk(), before + 1);
});

let emailTemplateId;

test('email: the sender is set, a template made, and its review checked', async () => {
    const sender = body => ownerA.call(app(orgA, '/social/email'), { method: 'PUT', body });
    assert.equal((await staffA.call(app(orgA, '/social/email'), { method: 'PUT', body: {} })).status, 403);
    assert.equal((await sender({ domain: 'galleryvayu.com', from: 'invites@other.com', fromName: 'Vayu' })).status, 400);
    assert.equal((await sender({ domain: 'galleryvayu.com', from: 'invites@galleryvayu.com', fromName: '' })).status, 400);
    const ok = await sender({ domain: 'GalleryVayu.com', from: 'Invites@galleryvayu.com', fromName: 'Vayu Gallery', replyTo: 'hello@galleryvayu.com' });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.body.email, { domain: 'galleryvayu.com', from: 'invites@galleryvayu.com', fromName: 'Vayu Gallery', replyTo: 'hello@galleryvayu.com' });

    const email = { channel: 'email', name: 'email_opening', language: 'en', header: 'none', headerText: 'You’re invited, {{name}}', body: 'Hello {{name}},\n\nJoin us for {{event}}.', buttons: rules.RSVP_BUTTONS };
    assert.equal((await post(ownerA, app(orgA, '/social/templates'), { ...email, headerText: '' })).status, 400); // no subject
    const made = await post(ownerA, app(orgA, '/social/templates'), email);
    assert.equal(made.status, 201, made.text);
    emailTemplateId = made.body.id;
    const toMsg91 = calls.findLast(c => c.path.endsWith('/email/templates')).body;
    assert.equal(toMsg91.subject, 'You’re invited, {{name}}');
    assert.ok(toMsg91.body.includes('{{rsvp_yes_url}}') && toMsg91.body.includes('Vayu Gallery'));

    // Lists are per channel; the review result comes from MSG91 by slug.
    assert.ok(!(await ownerA.call(app(orgA, '/social/templates?channel=whatsapp'))).body.templates.some(t => t.id === emailTemplateId));
    emailTemplates.set('email_opening_7', 2);
    const list = await ownerA.call(app(orgA, '/social/templates?channel=email&refresh=1'));
    assert.deepEqual([list.body.checked, list.body.templates.map(t => [t.id, t.status])], [true, [[emailTemplateId, 'approved']]]);
});

test('email: an invite goes to tagged contacts with an address, with their own links; reports, RSVP and unsubscribe work', async () => {
    const tag = (await post(ownerA, app(orgA, '/contact-tags'), { name: 'Email OK', color: '' })).body.id;
    for (const [id, name, emails] of [['e1', 'Meera Iyer', ['Meera@Example.com']], ['e2', 'Kabir', ['kabir@example.com']], ['e3', 'No Email', []]]) {
        const res = await post(ownerA, app(orgA, '/contacts'), { id, name, phones: [], emails, tags: [tag], notes: '' });
        assert.ok(res.status < 300, res.text);
    }
    const reach = await ownerA.call(app(orgA, `/social/audience?channel=email&tags=${tag}`));
    assert.deepEqual([reach.body.total, reach.body.reachable], [3, 2]);

    const made = await post(ownerA, app(orgA, '/social/invites'), { channel: 'email', name: 'Email opening', templateId: emailTemplateId, tagIds: [tag], values: { event: 'Monsoon Show' } });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.body.channel, 'email');
    const detail = () => ownerA.call(app(orgA, `/social/invites/${made.body.id}`));
    const sent = await until(async () => { const d = await detail(); return d.body.invite.status === 'sent' && d; }, 'the email invite to be sent');
    assert.deepEqual(sent.body.recipients.map(r => r.phone), ['kabir@example.com', 'meera@example.com']);
    const request = calls.findLast(c => c.path.endsWith('/email/send')).body;
    assert.deepEqual([request.template_id, request.domain, request.from, request.reply_to], ['email_opening_7', 'galleryvayu.com', { name: 'Vayu Gallery', email: 'invites@galleryvayu.com' }, [{ email: 'hello@galleryvayu.com' }]]);
    const meera = request.recipients.find(r => r.to[0].email === 'meera@example.com');
    assert.deepEqual([meera.variables.name, meera.variables.event], ['Meera', 'Monsoon Show']);
    assert.ok(!(await ownerA.call(app(orgA, '/social/invites?channel=whatsapp'))).body.invites.some(i => i.id === made.body.id));

    // Reports find the person by address; their RSVP and unsubscribe links work without a sign-in, and only as given.
    const requestId = `u_${calls.findLastIndex(c => c.path.endsWith('/email/send')) + 1}`;
    assert.equal(await report(hookUrl, { eventName: 'Delivered', recipient: 'meera@example.com', requestId }), 200);
    assert.equal(await report(hookUrl, { eventName: 'Opened', recipient: 'Meera@example.com', requestId }), 200);
    assert.equal(await report(hookUrl, { eventName: 'Failed', recipient: 'kabir@example.com', reason: '550 mailbox not found' }), 200);
    const yes = new URL(meera.variables.rsvp_yes_url);
    assert.equal((await fetch(`${worker.origin}${yes.pathname.replace(/\/[a-f0-9]{32}\//, `/${'1'.repeat(32)}/`)}`)).status, 404);
    const page = await fetch(`${worker.origin}${yes.pathname}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /coming/);
    const after = (await detail()).body;
    assert.deepEqual(after.recipients.map(r => [r.phone, r.status, r.rsvp]), [['kabir@example.com', 'failed', ''], ['meera@example.com', 'read', 'yes']]);

    assert.equal((await fetch(`${worker.origin}${new URL(meera.variables.unsubscribe_url).pathname}`)).status, 200);
    const later = await ownerA.call(app(orgA, `/social/audience?channel=email&tags=${tag}`));
    assert.deepEqual([later.body.reachable, later.body.optedOut], [1, 1]);
});

test('a scheduled invite can be cancelled; a sent one can be resent to those it failed to reach', async () => {
    const tag = (await ownerA.call(app(orgA, '/contact-tags'))).body.find(t => t.name === 'WhatsApp OK').id;
    const scheduled = await post(ownerA, app(orgA, '/social/invites'), { name: 'Later', templateId, tagIds: [tag], values: { event: 'Show', date: 'Fri' }, sendAt: Date.now() + 86_400_000 });
    assert.equal(scheduled.status, 201, scheduled.text);
    assert.equal((await staffA.call(app(orgA, `/social/invites/${scheduled.body.id}`), { method: 'DELETE' })).status, 403);
    assert.equal((await ownerA.call(app(orgA, `/social/invites/${scheduled.body.id}`), { method: 'DELETE' })).status, 200);
    assert.equal((await ownerA.call(app(orgA, `/social/invites/${scheduled.body.id}`))).status, 404);

    // The first WhatsApp invite: Dr. Rao failed (not on WhatsApp); Anjali read it but has since replied STOP.
    const first = (await ownerA.call(app(orgA, '/social/invites?channel=whatsapp'))).body.invites.find(i => i.name === 'Opening');
    assert.equal((await ownerA.call(app(orgA, `/social/invites/${first.id}`), { method: 'DELETE' })).status, 409); // already sent
    const before = calls.filter(c => c.path.endsWith('/whatsapp-outbound-message/bulk/')).length;
    const again = await post(ownerA, app(orgA, `/social/invites/${first.id}/retry`));
    assert.equal(again.status, 201, again.text);
    assert.deepEqual([again.body.name, again.body.counts.total, again.body.templateId], ['Opening (again)', 1, templateId]);
    const sent = await until(async () => { const d = await ownerA.call(app(orgA, `/social/invites/${again.body.id}`)); return d.body.invite.status === 'sent' && d; }, 'the resend');
    assert.deepEqual(sent.body.recipients.map(r => r.name), ['Dr. Rao']);
    assert.equal(calls.filter(c => c.path.endsWith('/whatsapp-outbound-message/bulk/')).length, before + 1);
    assert.equal((await post(ownerA, app(orgA, `/social/invites/${again.body.id}/retry`))).status, 409); // nobody failed on it
});

test('reach: each tag’s contacts on WhatsApp and by email, without those who opted out', async () => {
    const reach = await ownerA.call(app(orgA, '/social/reach'));
    assert.equal(reach.status, 200, reach.text);
    const wa = reach.body.tags.find(t => t.name === 'WhatsApp OK');
    const em = reach.body.tags.find(t => t.name === 'Email OK');
    assert.deepEqual([wa.contacts, wa.whatsapp, wa.email], [3, 1, 0]); // Anjali replied STOP; one has no phone
    assert.deepEqual([em.contacts, em.whatsapp, em.email], [3, 0, 1]); // Meera unsubscribed
    assert.ok(reach.body.optouts.some(o => o.address === '919811111111') && reach.body.optouts.some(o => o.address === 'meera@example.com'));
    assert.equal(reach.body.totals.optedOut, 2);
    assert.equal((await ownerB.call(app(orgA, '/social/reach'))).status, 404);
});
