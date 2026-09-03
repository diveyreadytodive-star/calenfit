import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { POLICY_SOURCE_REGISTRY } from "../policy-sources.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverSource = await readFile(resolve(root, "server.mjs"), "utf8");
const policies = [];
for (const line of serverSource.split("\n")) {
  const title = line.match(/title:\s*"([^"]+)"/)?.[1];
  const url = line.match(/url:\s*"(https:[^"]+)"/)?.[1];
  if (title && url) policies.push({ kind: "policy", title, url });
}
for (const source of Object.values(POLICY_SOURCE_REGISTRY)) policies.push({ kind: "portal", title: source.name, url: source.homepage });

const allowedHosts = ["go.kr", "gov.kr", "work24.go.kr", "jobaba.net", "mnuri.kr", "kspo.or.kr", "khepi.or.kr", "kosaf.go.kr", "bokjiro.go.kr", "youthcenter.go.kr", "busan.go.kr"];
const unique = [...new Map(policies.map(item => [item.url, item])).values()];

async function inspect(item) {
  const host = new URL(item.url).hostname;
  if (!allowedHosts.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return { ...item, host, outcome: "rejected-host" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(item.url, { redirect: "follow", signal: controller.signal, headers: { "user-agent": "Calenfit-Policy-Source-Verifier/1.0" } });
    const body = response.ok ? await response.text() : "";
    const ignored = new Set(["2026년", "2026", "지원", "지원사업", "사업", "확인", "정책", "청년"]);
    const contentHints = item.title.replace(/[()·+]/g, " ").split(/\s+/).map(value => value.replace(/[^0-9A-Za-z가-힣]/g, "")).filter(value => value.length >= 2 && !ignored.has(value)).sort((a, b) => b.length - a.length).slice(0, 4);
    const searchable = `${response.url} ${body}`.replace(/\s+/g, " ").toLowerCase();
    const matchedHints = contentHints.filter(hint => searchable.includes(hint.toLowerCase()));
    const contentMatched = contentHints.length === 0 || matchedHints.length > 0;
    const outcome = response.ok ? (contentMatched ? "verified-content" : item.kind === "portal" ? "verified-host" : "content-mismatch") : [401, 403, 429].includes(response.status) ? "access-controlled" : "failed";
    return { ...item, host, outcome, status: response.status, finalUrl: response.url, contentHints, matchedHints, contentMatched };
  } catch (error) {
    return { ...item, host, outcome: error.name === "AbortError" ? "timeout" : "failed", error: error.name };
  } finally { clearTimeout(timeout); }
}

const results = [];
for (let index = 0; index < unique.length; index += 4) results.push(...await Promise.all(unique.slice(index, index + 4).map(inspect)));
const summary = results.reduce((counts, result) => ({ ...counts, [result.outcome]: (counts[result.outcome] || 0) + 1 }), {});
const report = { checkedAt: new Date().toISOString(), total: results.length, summary, results };
await mkdir(resolve(root, "artifacts"), { recursive: true });
await writeFile(resolve(root, "artifacts/policy-source-verification.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`policy source verification: ${results.length} checked · ${Object.entries(summary).map(([key, value]) => `${key}=${value}`).join(" · ")}`);
process.exit(Boolean(summary["rejected-host"] || summary.failed || summary["content-mismatch"]) ? 1 : 0);
