/**
 * 最小可运行示例（Minimal runnable example）
 *
 * 用 @larksuiteoapi/node-sdk 接收飞书消息，并以 **CardKit schema 2.0** 卡片回复，
 * 同时处理卡片按钮回调（card.action.trigger）。
 *
 * 为什么能避开 ErrCode 200861 / unsupported tag action：
 *   - schema 2.0 的按钮必须直接放在 `body.elements` 里，tag 为 `button`；
 *   - 绝不能再用 1.0 时代那种 `{ tag: "action", actions: [...] }` 容器。
 *   下面 buildCard() 返回的卡片不会有任何 `action` 元素。
 *
 * 按钮（停止）通过 `behaviors: [{ type: "callback", ... }]` 触发 schema-2.0
 * 卡片回调，回调处理器把同一张卡更新成「已停止」。真实场景里这里应中止正在
 * 生成的 pi turn。
 *
 * 运行：
 *   LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx \
 *   node --experimental-strip-types examples/minimal.ts
 *
 * 然后在飞书里给机器人发一条消息即可看到 schema-2.0 卡片回复，点「停止」更新卡片。
 */

import {
  Client,
  WSClient,
  EventDispatcher,
  AppType,
  Domain,
  LoggerLevel,
} from '@larksuiteoapi/node-sdk';

const appId = process.env.LARK_APP_ID;
const appSecret = process.env.LARK_APP_SECRET;
if (!appId || !appSecret) {
  console.error('缺少环境变量 LARK_APP_ID / LARK_APP_SECRET');
  process.exit(1);
}

const STOP_ACTION = 'pi_feishu_stop';

/** 构建一个 CardKit schema 2.0 卡片：markdown 正文 + 一个按钮（直接在 elements 里） */
function buildCard(reply: string, stopped = false): object {
  const elements: unknown[] = [
    {
      tag: 'markdown',
      content: reply,
    },
  ];

  // 停止后就不再显示按钮
  if (!stopped) {
    elements.push({
      tag: 'button',
      type: 'danger',
      text: { tag: 'plain_text', content: '停止' },
      // 兼容旧 value 回调 + JSON 2.0 behaviors.callback
      value: { action: STOP_ACTION },
      behaviors: [{ type: 'callback', value: { action: STOP_ACTION } }],
    });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

const sdkClient = new Client({
  appId,
  appSecret,
  appType: AppType.SelfBuild,
  domain: Domain.Feishu,
  loggerLevel: LoggerLevel.error,
});

const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.error })
  .register({
    'im.message.receive_v1': async (data: unknown) => {
      const event = (data as any)?.event || data;
      const message = event?.message;
      if (!message) return undefined;

      // 忽略机器人自己的消息，避免循环
      if (event?.sender?.sender_type === 'bot') return undefined;
      // 只处理文本消息
      if (message.message_type !== 'text') return undefined;

      let text = '';
      try {
        text = JSON.parse(message.content || '{}').text || '';
      } catch {
        /* ignore */
      }

      console.log(`收到来自 ${message.chat_id} 的消息：${text}`);

      // 用 schema-2.0 卡片回复（msg_type: interactive）
      const card = buildCard(`收到：**${text}**\n\n这是 **schema 2.0** 卡片，按钮直接放在 elements 里 ✅`);
      try {
        await sdkClient.im.message.reply({
          path: { message_id: message.message_id },
          data: { msg_type: 'interactive', content: JSON.stringify(card) },
        });
      } catch (err) {
        console.error('回复失败：', err);
      }
      return undefined;
    },
  })
  // 卡片按钮回调（schema 2.0 通过 behaviors.callback 触发）
  .register({
    'card.action.trigger': async (data: unknown) => {
      const value = (data as any)?.action?.value;
      const messageId = (data as any)?.context?.open_message_id || (data as any)?.open_message_id;
      if (value?.action !== STOP_ACTION) return undefined;

      console.log(`收到停止请求，更新卡片 ${messageId} → 已停止`);
      // 真实场景：在这里中止正在生成的 pi turn（abort RPC prompt）。
      // 返回 schema-2.0 卡片 JSON，作为回调响应更新同一张卡。
      const updated = buildCard('已停止 ❌', true);
      // 回调响应格式：{ card: { type: "raw", data: <card json> } }
      return { card: { type: 'raw', data: updated } };
    },
  });

const wsClient = new WSClient({ appId, appSecret, domain: Domain.Feishu, loggerLevel: LoggerLevel.error });

console.log('飞书机器人已启动，等待消息…');
wsClient.start({ eventDispatcher: dispatcher });

process.on('SIGINT', () => {
  wsClient.stop?.().finally(() => process.exit(0));
});
