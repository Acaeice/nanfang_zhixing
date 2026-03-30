/*
 * 南方智行订阅逻辑验证脚本
 *
 * 目的：
 * 1. 先观察手机上真实命中的订阅/车辆详情接口，确认哪些响应里带有 tboxExpireTime / vipExpire。
 * 2. 再通过场景注入，把这些字段改成“已生效 / 7天预警 / 已过期”，验证我们恢复出的门控逻辑是否成立。
 *
 * Loon 参数：
 *   mode=observe | observe-full | active | warn7 | expired
 *   notify=1      是否弹通知
 *   strict=1      严格模式。默认只改响应里原本就存在的字段。
 *   target=both   both | tbox | vip，分别验证到底是哪个字段在起作用。
 *
 * 注意：
 * - 该脚本只处理 JSON 响应。
 * - observe 模式只记录，不改写响应。
 * - 默认 strict=1，优先保证“验证结果可信”而不是“尽量改到值”。
 * - 如果 observe 已确认 URL 正确但字段缺失，才建议临时使用 strict=0 扩大注入范围。
 * - 当前会同时观察可能参与门控的状态字段，如 isExpired / serviceStatus /
 *   statusCode / controlPermission / sharePermissions。
 */

const args = parseArgument(typeof $argument === "string" ? $argument : "");
const mode = args.mode || "observe";
const shouldNotify = args.notify === "1";
const isStrict = args.strict !== "0";
const target = args.target || "both";
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

  if (mode === "observe" || mode === "observe-full") {
    const summary = buildObservationSummary(discovery);
    const message = [
      "命中订阅相关响应",
      shortUrl(requestUrl),
      summary,
    ].join("\n");
    log(message);
    if (mode === "observe-full") {
      discovery.entries.forEach((entry) => {
        log(`字段快照 ${entry.path} = ${stringifyValue(entry.value)}`);
      });
      discovery.containers.forEach((container) => {
        log(
          `候选容器 ${container.path} keys=${container.keys.join(", ")} sample=${container.sample}`
        );
      });
    }
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
  patchKnownFields(json, scenario, patches, "$", target);
  if (!isStrict && patches.length === 0) {
    injectLikelyContainers(json, scenario, patches, target);
  }

  if (patches.length === 0) {
    const message = [
      "命中可疑接口，但未找到可改写字段",
      shortUrl(requestUrl),
      isStrict
        ? "当前是 strict=1，只会改真实存在的字段；先用 observe-full 看清结构，必要时再切 strict=0"
        : "建议先用 mode=observe-full 再看真实响应结构",
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
    `目标字段: ${target}`,
    `严格模式: ${isStrict ? "on" : "off"}`,
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
    expireBeginTime: begin,
    expireEndTime: expire,
    tboxExpireTime: expire,
    vipExpire: expire,
  };
}

function discoverFields(node, path, result) {
  const currentPath = path || "$";
  const output = result || { paths: [], entries: [], containers: [] };

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
    "isExpired",
    "serviceStatus",
    "statusCode",
    "status",
    "controlPermission",
    "sharePermissions",
    "dictionaryPermissions",
    "permissionList",
    "permissions",
    "available",
    "enabled",
    "isEnable",
    "isOpen",
    "canUse",
  ];

  watchedKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      const fieldPath = `${currentPath}.${key}`;
      output.paths.push(fieldPath);
      output.entries.push({
        path: fieldPath,
        value: node[key],
      });
    }
  });

  if (looksLikeCandidateContainer(node)) {
    output.containers.push({
      path: currentPath,
      keys: Object.keys(node).slice(0, 20),
      sample: buildObjectSample(node),
    });
  }

  Object.keys(node).forEach((key) => {
    discoverFields(node[key], `${currentPath}.${key}`, output);
  });

  return output;
}

function patchKnownFields(node, scenario, patches, path, targetType) {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      patchKnownFields(node[index], scenario, patches, `${path}[${index}]`, targetType);
    }
    return;
  }

  if (!isObject(node)) {
    return;
  }

  resolvePatchKeys(targetType).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      const beforeValue = node[key];
      node[key] = adaptScenarioValue(key, beforeValue, scenario[key]);
      patches.push(
        `${path}.${key}:${stringifyValue(beforeValue)}=>${stringifyValue(node[key])}`
      );
    }
  });

  Object.keys(node).forEach((key) => {
    patchKnownFields(node[key], scenario, patches, `${path}.${key}`, targetType);
  });
}

function injectLikelyContainers(root, scenario, patches, targetType) {
  const candidates = collectCandidateContainers(root);

  candidates.forEach((container) => {
    if (!isObject(container.node)) {
      return;
    }

    const patchKeys = resolvePatchKeys(targetType);
    const before = patchKeys.map((key) => container.node[key]).join("|");

    patchKeys.forEach((key) => {
      container.node[key] = adaptScenarioValue(key, container.node[key], scenario[key]);
    });

    const after = patchKeys.map((key) => container.node[key]).join("|");

    if (before !== after) {
      patches.push(`${container.path}.*:${before}=>${after}`);
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

function buildObservationSummary(discovery) {
  if (discovery.entries.length === 0) {
    return "字段: 未直接命中，但 URL 很像订阅/车辆详情接口";
  }

  return `字段: ${discovery.entries
    .map((entry) => `${entry.path}=${stringifyValue(entry.value)}`)
    .join(", ")}`;
}

function resolvePatchKeys(targetType) {
  const baseKeys = ["memberId", "memberName", "expireBeginTime", "expireEndTime"];
  if (targetType === "tbox") {
    return baseKeys.concat(["tboxExpireTime"]);
  }
  if (targetType === "vip") {
    return baseKeys.concat(["vipExpire"]);
  }
  return baseKeys.concat(["tboxExpireTime", "vipExpire"]);
}

function looksLikeCandidateContainer(node) {
  if (!isObject(node)) {
    return false;
  }
  const keys = Object.keys(node);
  return (
    [
      "memberId",
      "memberName",
      "vin",
      "vehicleVin",
      "tboxExpireTime",
      "vipExpire",
      "isExpired",
      "serviceStatus",
      "statusCode",
      "controlPermission",
      "sharePermissions",
      "dictionaryPermissions",
      "permissionList",
    ].some((key) =>
      keys.indexOf(key) !== -1
    ) ||
    ["carInfo", "userInfo", "userDetail", "vehicle", "data", "result"].some((key) =>
      keys.indexOf(key) !== -1
    )
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

function stringifyValue(value) {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return "[object]";
    }
  }
  return String(value);
}

function adaptScenarioValue(key, originalValue, scenarioValue) {
  if (
    key !== "tboxExpireTime" &&
    key !== "vipExpire" &&
    key !== "expireBeginTime" &&
    key !== "expireEndTime"
  ) {
    return scenarioValue;
  }

  const originalText = stringifyValue(originalValue);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(originalText)) {
    return formatDateTime(scenarioValue);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(originalText)) {
    return formatDate(scenarioValue);
  }

  return scenarioValue.toISOString();
}

function formatDateTime(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function buildObjectSample(node) {
  const sample = {};
  Object.keys(node)
    .slice(0, 12)
    .forEach((key) => {
      const value = node[key];
      if (isObject(value)) {
        sample[key] = "{...}";
        return;
      }
      if (Array.isArray(value)) {
        sample[key] = `[len=${value.length}]`;
        return;
      }
      sample[key] = stringifyValue(value);
    });
  return stringifyValue(sample);
}

function log(message) {
  console.log(`[nanfang-subscription-verify] ${message}`);
}

function finish() {
  $done({});
}
