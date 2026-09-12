import domainUtils from '../utils/domain-uitls';
import { Md5 } from '@smithy/md5-js';
import BizError from '../error/biz-error';

const MAX_WECOM_MARKDOWN_BYTES = 4096;
const MAX_WECOM_IMAGE_BYTES = 2 * 1024 * 1024;

function escapeMarkdown(value = '') {
	return String(value).replace(/([\\`*_{}\[\]()#+!|>])/g, '\\$1');
}

function displayAddress(name, address) {
	return name ? `${escapeMarkdown(name)} <${escapeMarkdown(address || '')}>` : escapeMarkdown(address || '');
}

function truncateUtf8(value, maxBytes) {
	const encoder = new TextEncoder();
	if (encoder.encode(value).byteLength <= maxBytes) return value;

	let result = '';
	for (const char of value) {
		if (encoder.encode(result + char + '…').byteLength > maxBytes) break;
		result += char;
	}
	return result + '…';
}

function buildWecomMarkdown(emailRow) {
	const details = [
		'# 收到新邮件',
		`**主题：** ${escapeMarkdown(emailRow.subject || '（无主题）')}`,
		`**发件人：** ${displayAddress(emailRow.name, emailRow.sendEmail)}`,
		`**收件人：** ${displayAddress(emailRow.toName, emailRow.toEmail)}`
	];

	if (emailRow.code) details.push(`**验证码：** \`${String(emailRow.code).replace(/`/g, '\\`')}\``);
	if (emailRow.createTime) details.push(`**时间：** ${escapeMarkdown(emailRow.createTime)}`);

	const text = String(emailRow.text || '')
		.trim()
		.split(/\r?\n/)
		.map(line => `> ${escapeMarkdown(line)}`)
		.join('\n');
	if (text) details.push(text);

	return truncateUtf8(details.join('\n\n'), MAX_WECOM_MARKDOWN_BYTES);
}

function extractImageUrls(html = '', assetDomain = '') {
	const normalizedDomain = domainUtils.toOssDomain(assetDomain) || '';
	const urls = [];
	const imagePattern = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
	let match;
	while ((match = imagePattern.exec(html))) {
		const url = match[1].replace('{{domain}}', normalizedDomain);
		if (/^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
	}
	return urls;
}

function toBase64(bytes) {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

async function md5Hex(bytes) {
	const md5 = new Md5();
	md5.update(bytes);
	const digest = await md5.digest();
	return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

const webhookService = {
	async testEmail(c, config = {}) {
		if (!config.webhookUrl) throw new BizError('Webhook 地址不能为空');
		const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
		const result = await this.sendEmail(c, {
			emailId: 0,
			sendEmail: 'test@example.com',
			name: 'Cloud Mail',
			toEmail: 'receiver@example.com',
			toName: 'Receiver',
			subject: 'Webhook 推送测试',
			text: '这是一封测试消息，用于验证 Webhook 配置是否可用。',
			content: '<p>这是一封测试消息，用于验证 Webhook 配置是否可用。</p>',
			code: '123456',
			createTime: now
		}, config.webhookUrl, config.webhookRetry, config.webhookSecret, config.webhookType, config.r2Domain);

		if (!result?.ok) throw new BizError(`Webhook 测试失败: ${result?.error || '未知错误'}`);
	},

	async sendEmail(c, emailRow, webhookUrl, retry = 0, webhookSecret, webhookType = 'generic', assetDomain = '') {

		webhookUrl = domainUtils.toOssDomain(webhookUrl);

		if (!webhookUrl) {
			return;
		}

		retry = Number(retry);
		if (isNaN(retry) || retry < 0) {
			retry = 0;
		}

		const headers = {
			'Content-Type': 'application/json'
		};

		if (webhookSecret) {
			headers['Authorization'] = webhookSecret;
		}

		const genericPayload = {
			emailId: emailRow.emailId,
			sendEmail: emailRow.sendEmail,
			sendName: emailRow.name,
			toEmail: emailRow.toEmail,
			toName: emailRow.toName,
			subject: emailRow.subject,
			text: emailRow.text,
			content: emailRow.content,
			code: emailRow.code,
			createTime: emailRow.createTime
		};

		if (webhookType === 'wecom') {
			const markdownResult = await this.sendPayload(webhookUrl, headers, {
				msgtype: 'markdown_v2',
				markdown_v2: { content: buildWecomMarkdown(emailRow) }
			}, retry, true);
			if (!markdownResult.ok) return markdownResult;

			for (const imageUrl of extractImageUrls(emailRow.content, assetDomain)) {
				try {
					const imageResponse = await fetch(imageUrl);
					const contentType = imageResponse.headers.get('content-type') || '';
					if (!imageResponse.ok || !contentType.startsWith('image/')) continue;
					const bytes = new Uint8Array(await imageResponse.arrayBuffer());
					if (!bytes.length || bytes.byteLength > MAX_WECOM_IMAGE_BYTES) continue;
					await this.sendPayload(webhookUrl, headers, {
						msgtype: 'image',
						image: { base64: toBase64(bytes), md5: await md5Hex(bytes) }
					}, retry, true);
				} catch (e) {
					console.warn(`Webhook 图片推送已跳过 ${imageUrl}: ${e.message}`);
				}
			}
			return markdownResult;
		}

		return this.sendPayload(webhookUrl, headers, genericPayload, retry, false);
	},

	async sendPayload(webhookUrl, headers, payload, retry, checkWecomResult) {
		const body = JSON.stringify(payload);

		let lastError = '';

		for (let i = 0; i <= retry; i++) {
			try {
				const res = await fetch(webhookUrl, {
					method: 'POST',
					headers,
					body
				});

				if (res.ok) {
					if (!checkWecomResult) return { ok: true };
					const result = await res.json();
					if (result.errcode === 0) return { ok: true };
					lastError = `errcode: ${result.errcode} errmsg: ${result.errmsg || ''}`;
					continue;
				}

				lastError = `status: ${res.status} response: ${await res.text()}`;
			} catch (e) {
				lastError = e.message;
			}
		}

		console.error(`Webhook 推送失败: ${lastError}`);
		return { ok: false, error: lastError };
	}

};

export default webhookService;

export { buildWecomMarkdown, extractImageUrls };
