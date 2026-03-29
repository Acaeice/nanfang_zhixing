/*
 * 南方智行订阅逻辑验证脚本
 *
 * 目的：
 * 1. 先观察手机上真实命中的订阅/车辆详情接口，确认哪些响应里带有 tboxExpireTime / vipExpire。
 * 2. 再通过场景注入，把这些字段改成“已生效 / 7天预警 / 已过期”，验证我们恢复出的门控逻辑是否成立。
 *
 * Loon 参数：
 *   mode=observe | active | warn7 | expired
 *   notify=1     是否弹通知
 *
 * 注意：
 * - 该脚本只处理 JSON 响应。
 * - observe 模式只记录，不改写响应。
 * - active / warn7 / expired 模式会尽量在命中的 JSON 容器中改写到期字段。
 */

const args = parseArgument(typeof $argument === "string" ? $argument : "");
const mode = args.mode || "observe";
const shouldNotify = args.notify === "1";
const requestUrl = safeGet(() => $request.url, "");
const responseBody = safeGet(() => $response.body, "");

const SCENARIOS = {
  active: buildScenario({
    memberId: "BTCL-SUB-VERIFY-ACTIVE",
    memberName: "TBOX 基础服务",
    expireOffsetDays: 32,
  }),
  warn7: buildScenario({
    memberId: "BTCL-SUB-VERIFY-WARN7",
    memberName: "TBOX 基础服务",
    expireOffsetDays: 7,
  }),
  expired: buildScenario({
    memberId: "BTCL-SUB-VERIFY-EXPIRED",
    memberName: "TBOX 基础服务",
    expireOffsetDays: -3,
  }),
};

main();

function main() {
  if (!responseBody) {
    finish();
    return;
  }

  const json = parseJson(responseBody);
  if (!json) {
    finish();
    return;
  }

  const discovery = discoverFields(json);
  const looksInteresting = discovery.paths.length > 0 || isLikelySubscriptionUrl(requestUrl);

  if (!looksInteresting) {
    finish();
    return;
  }

  if (mode === "observe") {
    const message = [
      "命中订阅相关响应",
      shortUrl(requestUrl),
      discovery.paths.length > 0 ? `字段: ${discovery.paths.join(", ")}` : "字段: 未直接命中，但 URL 很像订阅/车辆详情接口",
    ].join("\n");
    log(message);
    if (shouldNotify) {
      $notification.post("南方智行订阅观察", mode, message);
    }
    finish();
    return;
  }

  const scenario = SCENARIOS[mode];
  if (!scenario) {
    log(`未知 mode: ${mode}`);
    finish();
    return;
  }

  const patches = [];
  patchKnownFields(json, scenario, patches, "$");
  injectLikelyContainers(json, scenario, patches);

  if (patches.length === 0) {
    const message = [
      "命中可疑接口，但未找到可改写字段",
      shortUrl(requestUrl),
      "建议先用 mode=observe 再看真实响应结构",
    ].join("\n");
    log(message);
    if (shouldNotify) {
      $notification.post("南方智行订阅注入", mode, message);
    }
    finish();
    return;
  }

  const output = JSON.stringify(json);
  const message = [
    `已注入场景: ${mode}`,
    shortUrl(requestUrl),
    `改写: ${patches.join(", ")}`,
  ].join("\n");
  log(message);
  if (shouldNotify) {
    $notification.post("南方智行订阅注入", mode, message);
  }
  $done({ body: output });
}

function buildScenario(options) {
  const now = new Date();
  const begin = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const expire = new Date(now.getTime() + options.expireOffsetDays * 24 * 60 * 60 * 1000);
  return {
    memberId: options.memberId,
    memberName: options.memberName,
    expireBeginTime: begin.toISOString(),
    expireEndTime: expire.toISOString(),
    tboxExpireTime: expire.toISOString(),
    vipExpire: expire.toISOString(),
  };
}

function discoverFields(node, path, result) {
  const currentPath = path || "$";
  const output = result || { paths: [] };

  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      discoverFields(node[index], `${currentPath}[${index}]`, output);
    }
    return output;
  }

  if (!isObject(node)) {
    return output;
  }

  const watchedKeys = [
    "memberId",
    "memberName",
    "tboxExpireTime",
    "vipExpire",
    "expireBeginTime",
    "expireEndTime",
  ];

  watchedKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      output.paths.push(`${currentPath}.${key}`);
    }
  });

  Object.keys(node).forEach((key) => {
    discoverFields(node[key], `${currentPath}.${key}`, output);
  });

  return output;
}

function patchKnownFields(node, scenario, patches, path) {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      patchKnownFields(node[index], scenario, patches, `${path}[${index}]`);
    }
    return;
  }

  if (!isObject(node)) {
    return;
  }

  [
    "memberId",
    "memberName",
    "tboxExpireTime",
    "vipExpire",
    "expireBeginTime",
    "expireEndTime",
  ].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      node[key] = scenario[key];
      patches.push(`${path}.${key}`);
    }
  });

  Object.keys(node).forEach((key) => {
    patchKnownFields(node[key], scenario, patches, `${path}.${key}`);
  });
}

function injectLikelyContainers(root, scenario, patches) {
  const candidates = collectCandidateContainers(root);

  candidates.forEach((container) => {
    if (!isObject(container.node)) {
      return;
    }

    const before = [
      container.node.memberId,
      container.node.memberName,
      container.node.tboxExpireTime,
      container.node.vipExpire,
    ].join("|");

    container.node.memberId = scenario.memberId;
    container.node.memberName = scenario.memberName;
    container.node.tboxExpireTime = scenario.tboxExpireTime;
    container.node.vipExpire = scenario.vipExpire;
    container.node.expireBeginTime = scenario.expireBeginTime;
    container.node.expireEndTime = scenario.expireEndTime;

    const after = [
      container.node.memberId,
      container.node.memberName,
      container.node.tboxExpireTime,
      container.node.vipExpire,
    ].join("|");

    if (before !== after) {
      patches.push(`${container.path}.*`);
    }
  });
}

function collectCandidateContainers(root) {
  const results = [];
  const seen = [];

  [
    ["$.data", safeGet(() => root.data)],
    ["$.result", safeGet(() => root.result)],
    ["$.rows", safeGet(() => root.rows)],
    ["$.data.carInfo", safeGet(() => root.data.carInfo)],
    ["$.result.carInfo", safeGet(() => root.result.carInfo)],
    ["$.carInfo", safeGet(() => root.carInfo)],
    ["$.data.userInfo", safeGet(() => root.data.userInfo)],
    ["$.result.userInfo", safeGet(() => root.result.userInfo)],
    ["$.data.userDetail", safeGet(() => root.data.userDetail)],
    ["$.result.userDetail", safeGet(() => root.result.userDetail)],
    ["$.data.vehicle", safeGet(() => root.data.vehicle)],
    ["$.result.vehicle", safeGet(() => root.result.vehicle)],
    ["$.data", safeGet(() => root.data)],
    ["$", root],
  ].forEach((entry) => {
    const path = entry[0];
    const node = entry[1];
    if (!isObject(node)) {
      return;
    }
    if (seen.indexOf(node) !== -1) {
      return;
    }
    seen.push(node);
    results.push({ path, node });
  });

  return results;
}

function isLikelySubscriptionUrl(url) {
  return /(user\/detail|user\/profile|vehicle\/detail|vehicle\/index|car\/detail|car\/page|carpayrecord|dictionary\?code=car_subscribe_time|cashier)/i.test(
    url
  );
}

function parseArgument(argument) {
  const output = {};
  if (!argument) {
    return output;
  }
  argument.split("&").forEach((pair) => {
    const index = pair.indexOf("=");
    if (index === -1) {
      output[pair] = "";
      return;
    }
    const key = pair.slice(0, index);
    const value = pair.slice(index + 1);
    output[key] = value;
  });
  return output;
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch (error) {
    log(`JSON 解析失败: ${String(error)}`);
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeGet(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (error) {
    return fallback;
  }
}

function shortUrl(url) {
  return url.length > 140 ? `${url.slice(0, 137)}...` : url;
}

function log(message) {
  console.log(`[nanfang-subscription-verify] ${message}`);
}

function finish() {
  $done({});
}
