import { afterEach, describe, expect, it, vi } from 'vitest';
import webhookService from '../src/service/webhook-service';

const email = {
	emailId: 42,
	sendEmail: 'sender@example.com',
	name: 'Sender',
	toEmail: 'receiver@example.com',
	toName: 'Receiver',
	subject: 'Build *passed*',
	text: 'Line one\nLine two',
	content: '<p>Line one</p><p>Line two</p>',
	code: '123456',
	createTime: '2026-09-12 10:30:00'
};

describe('webhookService WeCom delivery', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('sends email details using the WeCom markdown_v2 payload', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errcode: 0 }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await webhookService.sendEmail({}, email, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test', 0, '', 'wecom');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const request = fetchMock.mock.calls[0][1];
		expect(JSON.parse(request.body)).toEqual({
			msgtype: 'markdown_v2',
			markdown_v2: {
				content: '# 收到新邮件\n\n**主题：** Build \\*passed\\*\n\n**发件人：** Sender <sender@example.com>\n\n**收件人：** Receiver <receiver@example.com>\n\n**验证码：** `123456`\n\n**时间：** 2026-09-12 10:30:00\n\n> Line one\n> Line two'
			}
		});
	});

	it('sends supported email images as separate non-linking image messages', async () => {
		const png = new Uint8Array([1, 2, 3, 4]);
		const fetchMock = vi.fn(async (url) => {
			if (url === 'https://cdn.example.com/picture.png') {
				return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
			}
			return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);

		await webhookService.sendEmail({}, {
			...email,
			content: '<p>With image</p><img src="https://cdn.example.com/picture.png">'
		}, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test', 0, '', 'wecom');

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
			msgtype: 'image',
			image: {
				base64: 'AQIDBA==',
				md5: '08d6c05a21512a79a1dfeb9d2a8f262f'
			}
		});
	});

	it('retries when WeCom returns a business error in a successful HTTP response', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 45009, errmsg: 'rate limit' }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0 }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await webhookService.sendEmail({}, email, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test', 1, '', 'wecom');

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
