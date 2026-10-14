/**
 * adapter.js — LLM 适配器
 *
 * 这一层的存在意义：让项目【不绑定任何一家厂商】。
 * 用户填 baseUrl + key + model 就能用；一旦某家把浏览器直连
 * 掐掉（CORS 被前置网关拦），只需把 baseUrl 换成自建的
 * Cloudflare Worker 代理地址，其余代码一行不用动。
 *
 * 已确认的事实（2026-10-10 用 tools/cors-probe.html 在**真浏览器**里逐家实测，
 * 并配 curl 做过网络可达性对照 —— 因为「没拿到响应」既可能是被 CORS 拦，
 * 也可能是本机根本连不上那家，两者在浏览器里都报 Failed to fetch，不区分就会误判）：
 *
 *  - 能浏览器直连（预检放行，部署成静态网站后别人打开就能用）：
 *      DeepSeek 官方 / 硅基流动 / 智谱 / 阿里百炼 / 月之暗面 /
 *      阶跃星辰 / OpenRouter / 百度千帆
 *  - 不能（预检被前置网关拦成 404，或缺 Allow-Methods / Allow-Headers）：
 *      商汤 SenseNova / Anthropic / 腾讯混元 / 讯飞星火
 *    OpenAI 官方本机网络不通，未能实测；按官方文档它也不建议浏览器直连。
 *
 *  判据不是「这家开不开 CORS」，而是「**预检这一关能不能过**」：有的服务商
 *  正式响应里明明带着 Access-Control-Allow-Origin，却对 OPTIONS 回 404，
 *  一样过不去（商汤就是这种）。
 *
 *  所以「纯前端」是可行的 —— 前提是选上面第一组。只有落在第二组时才需要
 *  自建代理（本机版见 tools/local-proxy.mjs，换成 Cloudflare Worker 同理）。
 *
 *  【2026-10-10 后续】第二组既然在浏览器里必然走不通，就**不再摆进设置面板**：
 *  选它等于给用户一个一定踩的坑 —— 填完 Key 只会看到一句 Failed to fetch，
 *  既看不出是地址写错还是这家不支持，也不知道该换成谁。判据直接用上面的
 *  `direct` 能力位，不另设一个迟早会和它走散的开关注。见 SELECTABLE_PRESETS。
 *  数据留着，是因为两件事还需要它：① 地址反推服务商时仍要认出这是哪一家；
 *  ② 老用户的配置可能正停在其中一家上 —— 那要照原样显示出来，不许静默改写。
 */

/**
 * 默认服务商。
 *
 * 这不是随便挑一个：本项目原来的默认是 Anthropic Claude，但那位用户从头到尾
 * 只连 DeepSeek。默认值点错，后果不只是「多改一次下拉」—— 预设同时决定
 * 【协议风格】(style)。Claude 走 anthropic 风格：请求打到 /messages、
 * 认证走 x-api-key。若用户已把地址改成了自建中转、服务商却还停在 Claude，
 * 就会用 Claude 的协议去打 DeepSeek 的地址，怎么调都不通，而界面上看不出
 * 任何异常。所以默认值必须是这个项目真正在用的那一家。
 */
export const DEFAULT_PROVIDER_ID = 'deepseek';

/**
 * `direct` = 能不能**浏览器直连**（实测值，不是营销话术）：
 *   true  → 静态网站里填上地址就能用，不需要任何后端
 *   false → 预检过不去，静态网站里用不了，得自建代理
 *   null  → 未知（用户自己的中转，取决于他有没有补 CORS 头）
 *
 * 这个字段会直接显示在设置面板上，并且**决定这家摆不摆进服务商下拉**
 * （见 SELECTABLE_PRESETS）：false 的那几家面板上根本没有，用户想选也选不到。
 * 用户要做「纯前端、别人打开就能用」的网站，只看这一条就够 —— 不必自己做 CORS 试验。
 */
export const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    style: 'openai',
    direct: true,
    baseUrl: 'https://api.deepseek.com/v1',
    // 这个站上有两个「默认先思考」的模型（deepseek-flash / deepseek-v4-pro），
    // 它们**只有点「拉取」才会出现在下拉里**，而默认值 deepseek-chat 是不思考的别名。
    // 实测同一句「以 JSON 给出决定」：
    //   deepseek-chat   0.99s /  25 token  → 正文完整，就是要的那个 JSON
    //   deepseek-v4-pro 7.34s / 456 token  → 白付 819 字思考
    //   deepseek-flash  4.41s / 800 token  → 正文**空的**（思考先把 max_tokens 吃光了）
    // 后两个选进来不报错，只会变慢变贵 —— 甚至拿不到正文，于是动作解析不出来、
    // 静默降到本地策略，而本地策略按设计不说话。这正是本项目最怕的那类
    // 「看不出来的坏」。所以默认值锁死在不思考的那个，别改。
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    note: '浏览器可直连，无需中转。默认 deepseek-chat 不思考、最快；拉取列表里的 flash / v4-pro 默认先思考，慢且费 token。',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    style: 'openai',
    direct: true,
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: '',
    models: [],
    note: '浏览器可直连，注册即有免费额度。点「拉取」读它的模型清单。',
  },
  {
    id: 'bigmodel',
    name: '智谱 BigModel',
    style: 'openai',
    direct: true,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-plus'],
    note: '浏览器可直连。glm-4-flash 有免费额度，够本项目这种调用量。',
  },
  {
    id: 'dashscope',
    name: '阿里百炼 DashScope',
    style: 'openai',
    direct: true,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-turbo',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
    note: '浏览器可直连，走的是它的 OpenAI 兼容端点。',
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    style: 'openai',
    direct: true,
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k'],
    note: '浏览器可直连。',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 StepFun',
    style: 'openai',
    direct: true,
    baseUrl: 'https://api.stepfun.com/v1',
    defaultModel: '',
    models: [],
    note: '浏览器可直连。点「拉取」读它的模型清单。',
  },
  {
    id: 'qianfan',
    name: '百度千帆',
    style: 'openai',
    direct: true,
    baseUrl: 'https://qianfan.baidubce.com/v2',
    defaultModel: '',
    models: [],
    note: '浏览器可直连，走 v2 的 OpenAI 兼容端点。点「拉取」读模型清单。',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    style: 'openai',
    direct: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: '',
    models: [],
    note: '浏览器可直连，一个 key 调多家模型；名字带 :free 后缀的有免费档。',
  },
  // ↓ 从这里往下三家：浏览器直连走不通（预检过不去），**设置面板里不再摆出来**。
  //   留着这三条数据是为了地址反推（认得出这是哪一家）和老配置的如实显示。
  //   谁要把它们重新摆回面板上，得先让 direct 变成 true —— 也就是先实测过预检。
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    style: 'anthropic',
    direct: false,
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'],
    note: '面板里已不再提供这一项：实测预检被拦（403），浏览器直连走不通。要用它得自建代理，并把地址填成代理地址。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    style: 'openai',
    direct: false,
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    note: '面板里已不再提供这一项：官方不建议在浏览器里直连，实测预检也过不去。需自建代理。',
  },
  {
    id: 'sensenova',
    name: '商汤 SenseNova',
    style: 'openai',
    direct: false,
    baseUrl: 'https://token.sensenova.cn/v1',
    defaultModel: 'sensenova-6.8-flash-lite',
    // 这里只放【确定能用】的：u1 / u1.5 系列是出图的（output_modalities 里没有
    // text），摆进下拉只会让人选中后开局报错。完整清单点「拉取」现读。
    models: ['sensenova-6.8-flash-lite'],
    // 这一家的模型默认「先想再答」，而且【思考的 token 也算进 max_tokens】。
    // 实测同一句话：带思考 8.6s / 思考 493 token；reasoning_effort:'none' → 1.2s / 思考 0。
    // 本项目的胜率是本地算好的，模型只负责从候选里挑一个，思考基本是重复劳动，
    // 白付 7 倍延迟，还把输出额度吃掉一大半（思考一长，正文就被截断）。
    // 合法值只有 low / medium / high / xhigh / none，写别的会被 400 拒掉。
    extraBody: { reasoning_effort: 'none' },
    note: '面板里已不再提供这一项：实测预检回 404，浏览器直连走不通，静态网站要用它必须自建代理（见 tools/local-proxy.mjs）。预设在，是因为它默认「先想再答」——真走中转时记得带上关闭思考的参数，它慢 7 倍，而胜率是本地算的。',
  },
  {
    id: 'custom',
    name: '自定义 / 自建代理',
    style: 'openai',
    direct: null,
    baseUrl: '',
    defaultModel: '',
    models: [],
    note: '填你自己的中转地址，需含版本段（如 /v1）。本机中转填 http://127.0.0.1:8788/v1，自建的 Cloudflare Worker 同理。',
  },
];

/**
 * 设置面板里真正摆出来的服务商。
 *
 * 判据就一条：**实测能浏览器直连**（`direct !== false`）。理由是本项目的立身之本 ——
 * 纯前端站点，别人打开就能用。摆出一个必然被 CORS 拦死的选项，用户只会得到一句
 * Failed to fetch：他既不知道自己填错了什么，也不知道该换成谁。这种选项不该存在。
 *
 * 为什么把判据挂在已有的 `direct` 上、而不是新加一个 `offered` 字段：
 * 两个开关迟早会走散（要么改了 direct 忘了 offered，要么反过来），而它们要表达的
 * 本来就是同一件事。少一个能自相矛盾的地方。
 *
 * 注意这不等于「这几家从此不能用」：走自建代理照样能用，只是在那条路上，上游是谁
 * 由中转地址决定 —— 面板里的「自定义 / 自建代理」就是为它准备的。
 */
export const SELECTABLE_PRESETS = PROVIDER_PRESETS.filter((p) => p.direct !== false);

/** 这家在面板上给不给选。老配置落在不给选的那几家上时，界面要另作交代。 */
export function isSelectable(id) {
  return SELECTABLE_PRESETS.some((p) => p.id === id);
}

export function getPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || PROVIDER_PRESETS.find((p) => p.id === DEFAULT_PROVIDER_ID) || PROVIDER_PRESETS[0];
}

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + path;
}

/**
 * 读取接口上的模型清单 —— 用户不该靠记忆手打模型名。
 *
 * 用标准 OpenAI 形状 GET {baseUrl}/models，商汤聚合站、DeepSeek 官方、
 * OpenRouter 都支持；Anthropic 也有同名端点（认证头不同）。
 *
 * 【要过滤】清单里混着「不输出文本」的模型（商汤那边 u1 / u1.5 系列是出图的），
 * 摊在列表里让用户选中，只会在开局时报一句莫名其妙的错。所以这里把各家
 * 自己声明的 output_modalities 带出来，交给调用方筛 —— 声明里没有这个字段的
 * 一律保留（未知不等于不能用）。
 */
export async function listModels({ config, fetchImpl = fetch, signal } = {}) {
  const { baseUrl, apiKey, style } = config || {};
  if (!baseUrl) throw new Error('未配置接口地址');

  const headers = style === 'anthropic'
    ? {
      'x-api-key': apiKey || '',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }
    : { authorization: `Bearer ${apiKey || ''}` };

  const res = await fetchImpl(joinUrl(baseUrl, '/models'), { method: 'GET', headers, signal });
  const data = await readJson(res);

  const list = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.models) ? data.models
      : Array.isArray(data) ? data : [];

  return list
    .map((m) => (typeof m === 'string' ? { id: m } : {
      id: m.id || m.name || '',
      description: m.description || '',
      outputs: Array.isArray(m.output_modalities) ? m.output_modalities : null,
    }))
    .filter((m) => m.id);
}

/**
 * 默认输出上限。
 *
 * 900 够写一段台词加几个动作 —— 前提是模型不「思考」。推理模型（如
 * sensenova-6.8-flash-lite）会先生成一段思考再回答，而【思考 token 也算在
 * 这个额度里】：实测一次很简单的回答就要 400 token 左右思考，900 在思考偏长
 * 时会把正文从中间切断（实测约 1/6 的决策撞上，且撞上之后重试没有用 ——
 * 重试用的是同一个额度，等于朝着同一堵墙撞三次）。
 *
 * 截断的表现和「格式写错」长得一模一样（都是 JSON 没闭合 → 解析失败），
 * 很容易被误判成提示词问题，所以这里给足余量。额度只是上限，模型写完就停，
 * 给多了不额外花钱。
 */
export const DEFAULT_MAX_TOKENS = 4096;

/** 这次返回是不是被输出上限截断的（截断时正文会缺一半） */
export function wasTruncated(res) {
  return !!res && (res.finishReason === 'length' || res.raw?.choices?.[0]?.finish_reason === 'length');
}

/**
 * 「等一会儿再来」的错误，不是「你写错了」。
 *
 * 这条界线很重要：限流（429）、网关抖动（502/503/504）、请求超时，
 * 都是等几秒就好的；把它们和「模型不听话」混在一起处理，症状是
 * 【AI 每撞一次限流就白白弃权一手】，而重试本来能救回来。
 *
 * 实测（token.sensenova.cn 的 deepseek-v4-flash，1 秒 1 个请求）：
 * 第 4 个开始 429，且 429 在 ~50ms 内瞬回（根本没进推理）；等 10 秒后恢复，
 * 但恢复后立刻密发又会马上被掐。服务端【不给 Retry-After 也不给任何
 * x-ratelimit-* 头】，所以退避时长只能自己定 —— 见 backoffMs。
 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** 默认重试次数（首次之外）。产品里等太久会毁掉牌局节奏，所以只给 2 次 */
export const DEFAULT_RETRIES = 2;

/**
 * 退避基数：第一次等 base，第二次等 2×base（再加 0~25% 抖动）。
 * 2500ms 是按实测定的 —— 见 backoffMs 的注释。
 */
export const DEFAULT_BACKOFF_BASE_MS = 2500;

/**
 * 这个错误值不值得再试一次。
 * 主动取消（外部 abort）不算 —— 那是用户自己不要了。
 */
export function isRetryable(err) {
  if (!err) return false;
  // 取消与超时都不自动重试：前者是用户不要了，后者再等一轮就是让人干等
  // （默认超时 90 秒，自动重试一次 = 白等三分钟）。两者都交给上层决定。
  if (err.name === 'AbortError') return false;
  if (err.status) return RETRYABLE_STATUS.has(err.status);
  // 没有 status 的是网络层错误：DNS 失败、连接被掐、socket 半途断掉。
  return /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|terminated/i.test(
    String(err.message || '')
  );
}

/**
 * 指数退避 + 抖动；服务端给了 Retry-After 就听它的。
 *
 * 基数与上限都是【实测出来的】，不是拍脑袋：
 * 在这家中转上 1 秒 1 个请求，第 4 个就被 429 掐掉，而【等 10 秒才恢复】。
 * 所以 1.2 秒那一档其实等不到窗口打开 —— 退避了等于没等，白白把一次
 * 真模型的决策让给本地兜底（实测：一局里 12 手是本地代打的）。
 * 换算下来「等多久」必须按秒算，不能按毫秒算。
 *
 * 为什么要抖动：多个智能体同时被拒，不做抖动就会在同一刻一起回来，
 * 然后一起再被拒 —— 退避反而变成了同步撞墙。
 *
 * override 是给自检留的口子（压到 1ms），否则每跑一次自检都要白等好几秒。
 */
function backoffMs(err, attempt, override, baseMs) {
  const hinted = Number(err && err.retryAfterMs);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted, 20000);
  if (Number.isFinite(override) && override >= 0) return override;
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : DEFAULT_BACKOFF_BASE_MS;
  const ms = base * 2 ** attempt;
  return Math.min(ms + ms * 0.25 * Math.random(), 12000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发起一次对话调用。
 * config = { style, baseUrl, apiKey, model, temperature, maxTokens, timeoutMs,
 *            extraBody, retries, backoffMs }
 *
 * 被限流 / 网关抖动时【自己退避重试】，不是一被拒就抛给上层 ——
 * 上层拿到异常只会当场改用本地兜底，等于 AI 白白弃权一手。
 * 不可重试的错误（认证被拒、参数写错）立刻抛，不浪费用户时间。
 *
 * extraBody 是给「各家自己的旋钮」留的口子：会原样并进请求体，同名字段以它为准。
 * 存在的理由：不同厂商的开关名字不一样，而且【有些参数被静默忽略】——
 * 实测 sensenova 认 reasoning_effort / thinking，但不认 enable_thinking
 * （传了不报错，也不生效）。猜不得，只能一家一个预设写死并实测。
 */
export async function callLLM({ config, system, user, signal, fetchImpl = fetch }) {
  const {
    style = 'openai',
    baseUrl,
    apiKey,
    model,
    temperature = 0.9,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = 90000,
    extraBody = null,
    retries,
    backoffMs: backoffOverride,
    backoffBaseMs,
  } = config || {};

  const extra = extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody) ? extraBody : {};

  if (!apiKey) throw new Error('未配置 API Key');
  if (!baseUrl) throw new Error('未配置接口地址');
  if (!model) throw new Error('未配置模型名');

  const attempts = Math.max(1, (Number.isFinite(Number(retries)) ? Number(retries) : DEFAULT_RETRIES) + 1);
  // 退避时长覆盖（毫秒）：产品不设，走默认的 1.2s / 2.4s / 4.8s；自检里压到 1ms。
  const backoffOverrideMs = Number(backoffOverride);

  /**
   * 一次尝试。超时与取消【每次独立重建】—— 否则第一次撞限流时，退避等待
   * 会把总超时预算吃掉，剩下几次尝试会一上来就判超时。
   */
  async function once() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });

    try {
      if (style === 'anthropic') {
        const res = await fetchImpl(joinUrl(baseUrl, '/messages'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature,
            system,
            messages: [{ role: 'user', content: user }],
            ...extra,
          }),
          signal: controller.signal,
        });
        const data = await readJson(res);
        const text = (data.content || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        return { text, usage: data.usage || null, finishReason: data.stop_reason || null, raw: data };
      }

      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: user });

      const res = await fetchImpl(joinUrl(baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, ...extra }),
        signal: controller.signal,
      });
      const data = await readJson(res);
      const text = data.choices?.[0]?.message?.content ?? '';
      return { text, usage: data.usage || null, finishReason: data.choices?.[0]?.finish_reason || null, raw: data };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await once();
      // retries 告诉调用方「这一次是等出来的」。限流严重的站上这个数字会很大，
      // 值得显示出来 —— 否则用户只看到「慢」，不知道是在重试。
      return { ...out, retries: i };
    } catch (err) {
      lastErr = err;
      const cancelled = !!(signal && signal.aborted);
      if (cancelled || i >= attempts - 1 || !isRetryable(err)) throw err;
      await sleep(backoffMs(err, i, backoffOverrideMs, backoffBaseMs));
    }
  }
  throw lastErr;
}

async function readJson(res) {
  const bodyText = await res.text();
  if (!res.ok) {
    let detail = bodyText.slice(0, 400);
    try {
      const parsed = JSON.parse(bodyText);
      detail = parsed.error?.message || parsed.message || detail;
    } catch {
      /* 保持原始文本 */
    }
    // 状态码必须带出去：调用方要拿它判断「等一会儿再来」还是「你写错了」。
    // 只给一句字符串的话，两件事长得一模一样。
    const err = new Error(`HTTP ${res.status} — ${detail}`);
    err.status = res.status;
    const ra = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    if (ra) {
      const sec = Number(ra);
      const ms = Number.isFinite(sec) ? sec * 1000 : Date.parse(ra) - Date.now();
      if (Number.isFinite(ms) && ms > 0) err.retryAfterMs = ms;
    }
    throw err;
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error(`返回内容不是合法 JSON：${bodyText.slice(0, 200)}`);
  }
}
