#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch.py — Claude in Chrome 官方包 → 网关增强版（Claude in Chrome for Gateway）

    original/  --(本脚本)-->  claude-gateway/

改动内容：
  1. 去除 Claude 登录：OAuth 启动器 / 登录页 / 静默重认证 全部改指网关配置
  2. 网关登录 + 自定义模型：gateway/shim.js（API 改写、推理参数、模态过滤、控制面合成）
     + 原生设置融合（options.html 原生集成网关配置选项卡）
  3. 历史会话功能：自动保存侧边栏交互上下文，支持搜索、导出 JSON、复制 Markdown、查看与删除
  4. 推理努力程度：支持 low/medium/high/xhigh/max（适配 Claude Opus 5.5 / 3.7 自适应思考）及自定义输入
  5. 权限管理增强：新增“直接允许所有网站”一键免确认授权功能
  6. 完整简体中文：内置 900+ 键全量 zh-CN.json，中文环境默认自动激活
  7. 删除 Anthropic 遥测：Sentry / Datadog / event_logging / GrowthBook / statsig / 追踪头
  8. 稳定性：修复 useMergedRefs/SlotClone 的 ref 抖动（React #185）、jE 广播、
     postures 短路、错误边界（崩溃可见 + componentStack 入诊断）

用法：python3 tools/patch.py
构建末尾会用 Node 以 ESM 模式强校验全部 JS（杜绝“node --check 脚本模式假阴性”）。
"""
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "original")
OUT = os.path.join(ROOT, "claude-gateway")
GWSRC = os.path.join(ROOT, "tools", "gateway-src")

BUILD = "1.0.99-gw"

# ---------------------------------------------------------------- i18n
I18N_NEW = {
    "FT1heKkksm": "网关登录（Gateway Sign-in）",
    "bcOjC+PEE7": "请在网关配置页填写 API 网关地址与 API Key，并添加自定义模型。",
    "+DtIv9XhvT": "在打开的网关配置页完成登录后，面板会自动恢复。",
    "Q6DdancLr/": "打开网关配置",
    "Q9R6MXxId1": "我已配置完成 — 重载",
    "hSbJ+q7PE/": "已配置完成？重载",
    "svPMOhpSDs": "若面板未自动恢复，请确认网关配置已保存，或在 chrome://extensions 中重新加载本扩展。",
    "5oZeuus9Dz": "网关模式（Gateway）",
    # 共享 UI 块的登录页（付费墙文案改为网关引导）
    "odXlk858Gb": "网关登录",
    "YXotZzdJDV": "本扩展使用自定义 API 网关，",
    "ed76A9b9lB": "点击下方按钮完成网关与模型配置",
    "2ZM4JNJI7K": "会话已过期",
    "ahcT/xfBaf": "请重新完成网关登录以继续使用。",
}

# ---------------------------------------------------------------- 文本补丁
# (文件, 旧文本, 新文本) —— 旧文本必须在文件中恰好出现一次
LITERAL_PATCHES = [
    # ==== 去除 Claude 登录 ====
    ("assets/sidepanel-so8SIo6y.js",
     "Ly=`${gr}/login`",
     'Ly=chrome.runtime.getURL("options.html#gateway")'),
    ("assets/SavedPromptsService-N3Mr18Wn.js",
     "Ir=async(t={})=>{",
     'Ir=async(t={})=>{return chrome.tabs.create({url:chrome.runtime.getURL("options.html#gateway")});'),
    ("assets/SavedPromptsService-N3Mr18Wn.js",
     's=await ur();if("disabled_by_gate"===s)return!1;',
     's="disabled_by_gate";if("disabled_by_gate"===s)return!1;'),
    ("assets/options-BT6rnEAa.js",
     'onClick:async()=>{try{await W()}catch(e){}},className:"px-3 py-2 bg-brand-100',
     'onClick:()=>{f("gateway")},className:"px-3 py-2 bg-brand-100'),

    # ==== 国际化：注册并默认激活 zh-CN ====
    ("assets/constants-CpkHHLjZ.js",
     'b=["en-US",',
     'b=["zh-CN","en-US",'),
    ("assets/constants-CpkHHLjZ.js",
     '_={"en-US":"English",',
     '_={"zh-CN":"简体中文","en-US":"English",'),
    ("assets/constants-CpkHHLjZ.js",
     'function S(){const e=navigator.language;',
     'function S(){const e=navigator.language;if(e.startsWith("zh"))return"zh-CN";'),

    # ==== 权限管理：全局允许所有网站 ====
    ("assets/SavedPromptsService-N3Mr18Wn.js",
     'constructor(t,e){this.getSkipAllPermissions=t,this.surface=e.surface',
     'constructor(t,e){this.getSkipAllPermissions=()=>(globalThis.__gatewayAllowAllSites||(typeof t==="function"&&t())),this.surface=e.surface'),
    ("assets/SavedPromptsService-N3Mr18Wn.js",
     'if(!this.forcePrompt&&this.getSkipAllPermissions())return{allowed:!0,permission:void 0};',
     'if(!this.forcePrompt&&(this.getSkipAllPermissions()||globalThis.__gatewayAllowAllSites))return{allowed:!0,permission:void 0};'),

    # ==== 设置页面融合：合并网关设置与历史会话到官方原生 Options ====
    ("assets/options-BT6rnEAa.js",
     't=["permissions","prompts","scheduled","options","internal"].includes(e)?e:"permissions"',
     't=["gateway","history","permissions","prompts","scheduled","options","internal"].includes(e)?e:"gateway"'),
    ("assets/options-BT6rnEAa.js",
     '[o,c]=(0,ce.useState)("permissions")',
     '[o,c]=(0,ce.useState)(()=>["gateway","history","permissions","prompts","scheduled","options","internal"].includes(window.location.hash.slice(1).split("?")[0])?window.location.hash.slice(1).split("?")[0]:"gateway")'),
    ("assets/options-BT6rnEAa.js",
     '(0,se.jsx)("li",{children:(0,se.jsx)(Pe,{href:"/settings/permissions",isActive:"permissions"===o,onClick:()=>f("permissions"),children:(0,se.jsx)(r,{defaultMessage:"Permissions",id:"SFuk1vRI4X"})})})',
     '(0,se.jsx)("li",{children:(0,se.jsx)(Pe,{href:"/settings/gateway",isActive:"gateway"===o,onClick:()=>f("gateway"),children:"网关设置"})}),(0,se.jsx)("li",{children:(0,se.jsx)(Pe,{href:"/settings/history",isActive:"history"===o,onClick:()=>f("history"),children:"历史会话"})}),(0,se.jsx)("li",{children:(0,se.jsx)(Pe,{href:"/settings/permissions",isActive:"permissions"===o,onClick:()=>f("permissions"),children:(0,se.jsx)(r,{defaultMessage:"Permissions",id:"SFuk1vRI4X"})})})'),
    ("assets/options-BT6rnEAa.js",
     '"permissions"===o&&(0,se.jsx)(pe,{})',
     '"gateway"===o&&(0,se.jsx)("iframe",{src:chrome.runtime.getURL("gateway/index.html?embed=1&tab=tab-gateway"),className:"w-full border-0 rounded-xl",style:{minHeight:"820px",height:"100%"}}),"history"===o&&(0,se.jsx)("iframe",{src:chrome.runtime.getURL("gateway/index.html?embed=1&tab=tab-history"),className:"w-full border-0 rounded-xl",style:{minHeight:"820px",height:"100%"}}),"permissions"===o&&(0,se.jsx)(pe,{})'),
    ("assets/options-BT6rnEAa.js",
     's||n?(0,se.jsxs)("div",{className:"grid md:grid-cols-[220px_minmax(0px,_1fr)]',
     '!0||s||n?(0,se.jsxs)("div",{className:"grid md:grid-cols-[220px_minmax(0px,_1fr)]'),
    ("assets/options-BT6rnEAa.js",
     '(0,se.jsxs)("div",{className:"bg-bg-100 border border-border-300 rounded-xl px-6 pt-6 pb-2 md:px-8 md:pt-8 md:pb-3",children:[(0,se.jsx)("h3",{className:"text-text-100 font-xl-bold",children:(0,se.jsx)(r,{defaultMessage:"Your approved sites",id:"NFf/0A3zf+"})})',
     '(0,se.jsxs)("div",{className:"bg-bg-100 border border-border-300 rounded-xl px-6 pt-6 pb-6 md:px-8 md:pt-8 md:pb-8 mb-6",children:[(0,se.jsxs)("div",{className:"flex items-center justify-between",children:[(0,se.jsxs)("div",{className:"flex-1 pr-4",children:[(0,se.jsx)("h3",{className:"text-text-100 font-xl-bold",children:"全局网站权限（免确认执行）"}),(0,se.jsx)("p",{className:"text-text-300 font-base mt-2",children:"开启后 Claude 可在所有网页自动执行操作，无需逐个站点弹出授权确认弹窗。"})]}),(0,se.jsx)("button",{type:"button",onClick:()=>{chrome.storage.local.get("gatewayAllowAllSites",e=>{const t=!(e&&e.gatewayAllowAllSites);chrome.storage.local.set({gatewayAllowAllSites:t},()=>{globalThis.__gatewayAllowAllSites=t,alert(t?"已开启：已直接允许所有网站访问！":"已关闭：将恢复逐站确认模式。"),location.reload()})})},className:"px-4 py-2 bg-brand-100 text-oncolor-100 rounded-lg font-base-sm hover:bg-brand-200 transition-colors cursor-pointer whitespace-nowrap",children:"直接允许所有网站"})]})]}),(0,se.jsxs)("div",{className:"bg-bg-100 border border-border-300 rounded-xl px-6 pt-6 pb-2 md:px-8 md:pt-8 md:pb-3",children:[(0,se.jsx)("h3",{className:"text-text-100 font-xl-bold",children:(0,se.jsx)(r,{defaultMessage:"Your approved sites",id:"NFf/0A3zf+"})})'),

    # ==== 消除 Options 页面与初次配置死锁：Options 页面直接无条件放行渲染 ====
    ("assets/SchedulingFields-c9Y6kagx.js",
     "return i?(0,Te.jsx)(bA,{}):o?",
     'if("Options"===t)return(0,Te.jsx)(AA.Provider,{value:c,children:(0,Te.jsx)(A,{children:e})});return i?(0,Te.jsx)(bA,{}):o?'),

    # ==== 删除 Anthropic 遥测 ====
    ("assets/SavedPromptsService-N3Mr18Wn.js",
     "function Ln(t){if(Un)return;Un=!0;",
     "function Ln(t){return;if(Un)return;Un=!0;"),
    ("assets/SavedPromptsService-N3Mr18Wn.js",
     'var s;ga(hc,r)}({dsn:"https://60bea3ee',
     'var s;return;ga(hc,r)}({dsn:"https://60bea3ee'),
    ("assets/SchedulingFields-c9Y6kagx.js",
     "fO=be(function(){if(me()&&!Y(G.RECORDS))return{",
     "fO=be(function(){if(!0)return{"),
    ("assets/mcpPermissions-tSjXinpi.js",
     'try{return new Function(""),!0}catch(e){return!1}',
     'return!1'),

    # ==== 本地 Native Messaging 桥接（允许明文工具调用与常驻连接）====
    ("assets/SavedPromptsService-N3Mr18Wn.js",
     'static async refusesClearText(){if(await this.isDesktopManaged())return!0;try{const t=await z(B.TOKEN_ORG);return Dt(t)?.hybrid??null!=t}catch{return!0}}',
     'static async refusesClearText(){return!1}'),
    ("assets/service-worker.ts-HKLyjT1Y.js",
     'var Qr=se({first:1e3,max:3e4},()=>{S()?.managed&&ei()});function Zr(){S()?.managed?Lr||Mr||Qr.arm():Qr.disarm()}',
     'var Qr=se({first:1e3,max:3e4},()=>{ei()});function Zr(){Lr||Mr||Qr.arm()};setTimeout(()=>ei(),500);'),

    # ==== 稳定性：useMergedRefs 稳定化（#185 根因 A）====
    ("assets/SchedulingFields-c9Y6kagx.js",
     "function tE(...e){return Ce.useCallback(eE(...e),e)}",
     "function tE(...e){const box=Ce.useRef(null),fn=Ce.useRef(null);return box.current=e,fn.current||(fn.current=t=>{let has=!1;const rets=box.current.map(ref=>{const r=J_(ref,t);return has||'function'!=typeof r||(has=!0),r});if(has)return()=>{for(let i=0;i<rets.length;i++){const r=rets[i];'function'==typeof r?r():J_(box.current[i],null)}}}),fn.current}"),

    # ==== 稳定性：SlotClone/触发器的 eE 直调改用稳定 tE（#185 根因 B）====
    ("assets/SchedulingFields-c9Y6kagx.js",
     "o.ref=t?eE(t,e):e",
     "o.ref=t?mr:e"),
    ("assets/SchedulingFields-c9Y6kagx.js",
     'if(Ce.isValidElement(n)){const e=function(e){let t=Object.getOwnPropertyDescriptor(e.props,"ref")?.get',
     'const mr=tE(t,Ce.isValidElement(n)?(function(e){let t=Object.getOwnPropertyDescriptor(e.props,"ref")?.get,n=t&&"isReactWarning"in t&&t.isReactWarning;return n?e.ref:(t=Object.getOwnPropertyDescriptor(e,"ref")?.get,n=t&&"isReactWarning"in t&&t.isReactWarning,n?e.props.ref:e.props.ref||e.ref)})(n):null);if(Ce.isValidElement(n)){const e=function(e){let t=Object.getOwnPropertyDescriptor(e.props,"ref")?.get'),
    ("assets/SchedulingFields-c9Y6kagx.js",
     "ref:eE(t,o.onTriggerChange)",
     "ref:tE(t,o.onTriggerChange)"),
    ("assets/SchedulingFields-c9Y6kagx.js",
     "ref:eE(t,i.triggerRef)",
     "ref:tE(t,i.triggerRef)"),
    ("assets/SchedulingFields-c9Y6kagx.js",
     "function jE(){const e=new CustomEvent(kE);document.dispatchEvent(e)}",
     "function jE(){}"),

    # ==== 稳定性：其余 ====
    ("assets/SchedulingFields-c9Y6kagx.js",
     "isAuthenticated:t&&!!a}",
     "isAuthenticated:!!t||!!a}"),
    ("assets/sidepanel-so8SIo6y.js",
     "else if(!l||n)h=(0,Oo.jsx)(hoe,{});",
     "else if(!0)h=(0,Oo.jsx)(hoe,{});"),
    ("assets/sidepanel-so8SIo6y.js",
     "(0,Ao.useEffect)(()=>{n.options&&g(n.options)},[n.options]);",
     "(0,Ao.useEffect)(()=>{n.options&&g(e=>e&&e.length===n.options.length&&e.every((t,r)=>t===n.options[r])?e:n.options)},[n.options]);"),

    # ==== 侧边栏原生菜单：增加“历史会话”，设置打开原生 Options 完整标签页 ====
    ("assets/sidepanel-so8SIo6y.js",
     '(0,Oo.jsx)(wn,{onSelect:()=>r(),icon:(0,Oo.jsx)(Sy,{size:16}),children:(0,Oo.jsx)("span",{className:"text-sm",children:(0,Oo.jsx)(h,{defaultMessage:"Settings",id:"D3idYvSLF9"})})})',
     '(0,Oo.jsx)(wn,{onSelect:()=>chrome.tabs.create({url:chrome.runtime.getURL("options.html#history")}),icon:(0,Oo.jsx)("svg",{width:16,height:16,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round",className:"text-text-300",children:[(0,Oo.jsx)("circle",{cx:"12",cy:"12",r:"10"}),(0,Oo.jsx)("polyline",{points:"12 6 12 12 16 14"})]}),children:(0,Oo.jsx)("span",{className:"text-sm",children:"历史会话"})}),(0,Oo.jsx)(wn,{onSelect:()=>chrome.tabs.create({url:chrome.runtime.getURL("options.html#gateway")}),icon:(0,Oo.jsx)(Sy,{size:16}),children:(0,Oo.jsx)("span",{className:"text-sm",children:(0,Oo.jsx)(h,{defaultMessage:"Settings",id:"D3idYvSLF9"})})})'),

    # ==== 历史会话恢复：监听 gatewayPendingRestore 并即时注入侧边栏会话状态 ====
    ("assets/sidepanel-so8SIo6y.js",
     "const e=setTimeout(()=>{fr(vr.TEST_DATA_MESSAGES).then(e=>{e&&e.length>0&&x(e)})},100);return()=>clearTimeout(e)",
     'const loadGw=()=>{try{chrome.storage.local.get("gatewayPendingRestore",r=>{const p=r&&r.gatewayPendingRestore;if(p&&Array.isArray(p.messages)&&p.messages.length>0){const msgs=p.messages.map(m=>({role:m.role,content:Array.isArray(m.content)?m.content:[{type:"text",text:typeof m.content==="string"?m.content:(m.text||"")}]}));x(msgs),Ab.getState().setMessages(msgs),chrome.storage.local.remove("gatewayPendingRestore")}})}catch(e){}};loadGw();const onGw=(changes,area)=>{if(area==="local"&&changes&&changes.gatewayPendingRestore&&changes.gatewayPendingRestore.newValue)loadGw()};chrome.storage.onChanged.addListener(onGw);return()=>{chrome.storage.onChanged.removeListener(onGw)}'),

    # ==== 错误边界（记录诊断日志并提供重载）====
    ("assets/sidepanel-so8SIo6y.js",
     'xn(),No.createRoot(document.getElementById("root")).render((0,Oo.jsx)(Ao.StrictMode,{children:(0,Oo.jsx)(on,{pageName:"Side Panel",children:(0,Oo.jsx)(foe,{})})}));',
     'xn();class GWB extends Ao.Component{constructor(e){super(e);this.state={err:null}}static getDerivedStateFromError(e){return{err:e}}componentDidCatch(e,t){try{chrome.storage.local.get("gatewayDiagnostics",n=>{const r=(n&&n.gatewayDiagnostics)||[];r.unshift({kind:"boundary",ctx:"sidepanel",message:String(e&&e.message||e).slice(0,400),stack:String((e&&e.stack||"")+String.fromCharCode(10)+"--- componentStack ---"+String.fromCharCode(10)+(t&&t.componentStack||"")).slice(0,3000),ts:Date.now()});chrome.storage.local.set({gatewayDiagnostics:r.slice(0,25)})})}catch(o){}}render(){return this.state.err?(0,Oo.jsxs)("div",{className:"flex flex-col items-center justify-center h-screen gap-3 px-6 text-center",children:[(0,Oo.jsx)("div",{className:"text-text-200 text-sm",children:"界面加载异常"}),(0,Oo.jsx)("button",{onClick:()=>location.reload(),className:"underline text-text-200 mt-2 text-xs cursor-pointer",children:"点击重载"})]}):this.props.children}}No.createRoot(document.getElementById("root")).render((0,Oo.jsx)(Ao.StrictMode,{children:(0,Oo.jsx)(GWB,{children:(0,Oo.jsx)(on,{pageName:"Side Panel",children:(0,Oo.jsx)(foe,{})})})}));'),
]

# (文件, id, 新文案) —— 通过 id 锚点替换 defaultMessage 文本（同 id 多处全量替换）
MESSAGE_PATCHES = [
    ("assets/sidepanel-so8SIo6y.js", "FT1heKkksm", I18N_NEW["FT1heKkksm"]),
    ("assets/sidepanel-so8SIo6y.js", "bcOjC+PEE7", I18N_NEW["bcOjC+PEE7"]),
    ("assets/sidepanel-so8SIo6y.js", "+DtIv9XhvT", I18N_NEW["+DtIv9XhvT"]),
    ("assets/sidepanel-so8SIo6y.js", "Q6DdancLr/", I18N_NEW["Q6DdancLr/"]),
    ("assets/sidepanel-so8SIo6y.js", "Q9R6MXxId1", I18N_NEW["Q9R6MXxId1"]),
    ("assets/sidepanel-so8SIo6y.js", "hSbJ+q7PE/", I18N_NEW["hSbJ+q7PE/"]),
    ("assets/sidepanel-so8SIo6y.js", "svPMOhpSDs", I18N_NEW["svPMOhpSDs"]),
    ("assets/options-BT6rnEAa.js", "5oZeuus9Dz", I18N_NEW["5oZeuus9Dz"]),
    ("assets/options-BT6rnEAa.js", "AyGauyc55S", "配置网关"),
    ("assets/SchedulingFields-c9Y6kagx.js", "odXlk858Gb", I18N_NEW["odXlk858Gb"]),
    ("assets/SchedulingFields-c9Y6kagx.js", "YXotZzdJDV", I18N_NEW["YXotZzdJDV"]),
    ("assets/SchedulingFields-c9Y6kagx.js", "ed76A9b9lB", I18N_NEW["ed76A9b9lB"]),
    ("assets/SchedulingFields-c9Y6kagx.js", "2ZM4JNJI7K", I18N_NEW["2ZM4JNJI7K"]),
    ("assets/SchedulingFields-c9Y6kagx.js", "ahcT/xfBaf", I18N_NEW["ahcT/xfBaf"]),
]


def die(msg):
    print("ERROR:", msg)
    sys.exit(1)


def patch_literal(path, old, new):
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    n = src.count(old)
    if n != 1:
        die("literal patch match %d times in %s: %r" % (n, path, old[:80]))
    src = src.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    print("  patched:", os.path.basename(path), "->", old[:56])


def patch_message(path, msg_id, text):
    pat = re.compile(r'defaultMessage:"[^"]*",id:"' + re.escape(msg_id) + r'"')
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    hits = pat.findall(src)
    if not hits:
        die("message patch match 0 times in %s (id=%s)" % (path, msg_id))
    repl = 'defaultMessage:"%s",id:"%s"' % (text.replace('"', '\\"'), msg_id)
    src = pat.sub(lambda m: repl, src)
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    print("  message:", os.path.basename(path), msg_id, "(x%d)" % len(hits))


def patch_i18n():
    i18n_dir = os.path.join(OUT, "i18n")
    # 注入预构建的全量简体中文翻译包 zh-CN.json
    zh_src = os.path.join(GWSRC, "zh-CN.json")
    if os.path.isfile(zh_src):
        shutil.copy2(zh_src, os.path.join(i18n_dir, "zh-CN.json"))
        print("  i18n: installed zh-CN.json")
    for fn in sorted(os.listdir(i18n_dir)):
        if not fn.endswith(".json"):
            continue
        p = os.path.join(i18n_dir, fn)
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        changed = False
        for k, v in I18N_NEW.items():
            if k in data:
                data[k] = v
                changed = True
        if changed:
            with open(p, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
            print("  i18n:", fn)


def patch_manifest():
    p = os.path.join(OUT, "manifest.json")
    with open(p, "r", encoding="utf-8") as f:
        m = json.load(f)
    m["name"] = "Claude in Chrome for Gateway"
    m["description"] = ("Claude in Chrome 网关增强版：去除 Claude 账号绑定限制，直接支持自定义 API 网关与第三方模型（兼容 Claude 3.7 / Opus 5.5 推理努力程度），内置历史会话、全局网页免确认授权及完整简体中文界面，彻底移除 Anthropic 遥测。")
    m.pop("update_url", None)   # 禁用商店自动更新（防止覆盖修改）
    m.pop("key", None)          # 与官方版共存，避免扩展 ID 冲突
    m["options_page"] = "options.html"
    m["content_security_policy"] = {
        "extension_pages": (
            "script-src 'self'; object-src 'self'; "
            "connect-src 'self' https: wss: http:; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:;"
        )
    }
    with open(p, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    print("  manifest.json updated")


def inject_shim(html_path, before_substr):
    with open(html_path, "r", encoding="utf-8") as f:
        src = f.read()
    tag = '<script src="/gateway/shim.js"></script>'
    if tag in src:
        return
    idx = src.find(before_substr)
    if idx < 0:
        die("cannot find anchor in %s: %r" % (html_path, before_substr))
    src = src[:idx] + "    " + tag + "\n    " + src[idx:]
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(src)
    print("  shim injected:", os.path.basename(html_path))


def find_node():
    for cand in ("node", "/mnt/c/Program Files/nodejs/node.exe"):
        try:
            subprocess.run([cand, "--version"], capture_output=True, check=True)
            return cand
        except Exception:
            continue
    return None


def esm_check(node):
    """以 ESM 模式强校验所有 JS（node --check 脚本模式会漏报！）"""
    bad = []
    targets = []
    for root, _dirs, files in os.walk(OUT):
        for f in files:
            if f.endswith(".js"):
                targets.append(os.path.join(root, f))
    for path in sorted(targets):
        with open(path, "rb") as fh:
            data = fh.read()
        r = subprocess.run([node, "--input-type=module", "--check"], input=data,
                           capture_output=True)
        if r.returncode != 0:
            bad.append((os.path.relpath(path, OUT), r.stderr.decode("utf-8", "ignore")[:400]))
    if bad:
        print("\n!!! ESM 语法校验失败 !!!")
        for name, err in bad:
            print(" ", name, "\n   ", err.replace("\n", "\n    ")[:600])
        die("build contains invalid JavaScript")
    print("  ESM syntax check: %d files OK" % len(targets))


def main():
    if not os.path.isdir(SRC):
        die("missing %s — 先运行 tools/fetch_crx.py" % SRC)

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)

    def ignore(dir_, names):
        return [n for n in names if n == "_metadata"]
    shutil.copytree(SRC, OUT, ignore=ignore)
    print("copied original -> claude-gateway/")

    # 1) 新增 gateway/ 目录（shim + 配置页）
    shutil.copytree(GWSRC, os.path.join(OUT, "gateway"))
    print("gateway/ installed")

    # 2) 文本补丁
    for rel, old, new in LITERAL_PATCHES:
        patch_literal(os.path.join(OUT, rel), old, new)
    for rel, msg_id, text in MESSAGE_PATCHES:
        patch_message(os.path.join(OUT, rel), msg_id, text)

    # 3) i18n
    patch_i18n()

    # 4) manifest
    patch_manifest()

    # 5) 入口加载 shim
    sw = os.path.join(OUT, "service-worker-loader.js")
    with open(sw, "r", encoding="utf-8") as f:
        sw_src = f.read()
    if "gateway/shim.js" not in sw_src:
        with open(sw, "w", encoding="utf-8") as f:
            f.write('import "./gateway/shim.js";\n' + sw_src)
    print("  service-worker-loader.js updated")

    inject_shim(os.path.join(OUT, "sidepanel.html"),
                '<script type="module" crossorigin src="/assets/sidepanel-so8SIo6y.js"></script>')

    # 6) options.html 注入 shim 并保留为官方原生设置
    options_html = os.path.join(OUT, "options.html")
    inject_shim(options_html,
                '<script type="module" crossorigin src="/assets/options-BT6rnEAa.js"></script>')
    # 兼容原 settings.html 路径
    settings = os.path.join(OUT, "settings.html")
    shutil.copy2(options_html, settings)
    print("  options.html & settings.html updated with unified gateway options")

    # 7) ESM 强校验（防假阴性）
    node = find_node()
    if node:
        esm_check(node)
    else:
        print("  (node 不可用，跳过 ESM 校验 —— 请手工验证!)")

    print("\nBUILD OK ->", OUT)


if __name__ == "__main__":
    main()
