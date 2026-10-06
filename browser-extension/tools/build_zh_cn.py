import json, os, re

def build_zh_cn():
    en_path = 'browser-extension/claude-gateway/i18n/en-US.json'
    with open(en_path, 'r', encoding='utf-8') as f:
        en = json.load(f)

    # 常见翻译映射表
    translations = {
        # 基础操作与界面
        "Image": "图片",
        "Connect": "连接",
        "Code": "代码",
        "Scrolling": "正在滚动",
        "Clicked": "已点击",
        "Settings": "设置",
        "Clear chat": "清空对话",
        "Menu": "菜单",
        "Language": "语言",
        "Shortcuts": "快捷指令",
        "Permissions": "权限",
        "Scheduled tasks": "计划任务",
        "Account": "账户",
        "Log in": "登录",
        "Log out": "退出登录",
        "Cancel": "取消",
        "Save": "保存",
        "Delete": "删除",
        "Edit": "编辑",
        "Confirm": "确认",
        "Close": "关闭",
        "Done": "完成",
        "Retry": "重试",
        "Copy": "复制",
        "Copied": "已复制",
        "Refresh": "刷新",
        "Search": "搜索",
        "Send": "发送",
        "Stop": "停止",
        "Back": "返回",
        "Next": "下一步",
        "Loading": "加载中…",
        "Loading permissions...": "正在加载权限…",
        "Loading...": "加载中…",
        "Allow": "允许",
        "Deny": "拒绝",
        "Always allow": "总是允许",
        "Ask every time": "每次询问",
        "Unknown domain": "未知域名",
        "Convert to task": "转为任务",
        "Converting to task": "正在转为任务",
        "New chat": "新会话",
        "History": "历史会话",
        "Chat history": "历史会话",
        "Claude in Chrome settings": "Claude in Chrome 设置",
        "Debug Settings": "调试设置",
        "Show performance trace pill": "显示性能追踪标签",
        "Wait for Claude to finish": "等待 Claude 执行完成",
        "Created GIF": "已生成 GIF",
        "Running command": "正在执行指令",
        "New permissions required": "需要新的网站权限",
        "Invalid time format": "时间格式无效",
        "Too many upload attempts. Wait a moment and try again.": "上传尝试次数过多，请稍候再试。",
        "See something Claude should know about? Send a screenshot with a message.": "有需要 Claude 了解的内容？随消息发送一张屏幕截图。",
        "What was unsatisfying about this response?": "对这条回复有何不满意的地方？",
        "Couldn't zoom in": "无法放大",
        "When navigating between these sites": "在这些站点之间跳转时",
        "Claude content": "Claude 内容",
        "Created {count} memories": "已创建 {count} 条记忆",
        "Your organization requires you to sign in with a specific account. Log out and sign in with an approved account.": "您的组织要求使用特定账号登录。请退出并使用已授权账号登录。",
    }

    # 翻译词根规则与替换
    exact_map = {
        "Ask before acting": "操作前询问",
        "Take actions without asking": "无需询问直接操作",
        "Follow a plan": "遵循计划执行",
        "Skip all permission checks": "跳过所有权限检查（直接允许）",
        "Allow all sites": "允许所有网站",
        "Always allow this site": "总是允许该网站",
        "Enable microphone": "开启麦克风",
        "Recording workflow without speech.": "无语音录制工作流。",
        "Voice narration": "语音旁白",
        "Create shortcut": "创建快捷指令",
        "Edit shortcut": "编辑快捷指令",
        "Delete shortcut": "删除快捷指令",
        "Run shortcut": "运行快捷指令",
        "No shortcuts yet": "暂无快捷指令",
        "No scheduled tasks": "暂无计划任务",
        "Create scheduled task": "创建计划任务",
        "Schedule": "定时调度",
        "Active": "已激活",
        "Paused": "已暂停",
        "Frequency": "执行频率",
        "Daily": "每天",
        "Weekly": "每周",
        "Monthly": "每月",
        "Hourly": "每小时",
        "Status": "状态",
        "Actions": "操作",
        "Tools": "工具",
        "Computer": "电脑控制",
        "Browser": "浏览器控制",
        "Navigation": "页面导航",
        "Click": "点击",
        "Type": "输入文本",
        "Scroll": "滚动",
        "Screenshot": "截图",
        "Page text": "页面文本",
        "DOM content": "DOM 内容",
        "Model": "模型",
        "Thinking": "思考过程",
        "Thinking budget": "思考预算",
        "Effort": "努力程度",
        "Tokens": "Token",
        "Input tokens": "输入 Token",
        "Output tokens": "输出 Token",
        "Temperature": "温度 (Temperature)",
        "Top P": "Top P",
        "Max tokens": "最大 Token 数",
        "System prompt": "系统提示词",
        "Gateway": "网关",
        "Gateway settings": "网关设置",
        "Base URL": "网关地址",
        "API Key": "API 密钥",
        "Auth type": "认证方式",
        "Test connection": "测试连接",
        "Save and log in": "保存并登录",
        "Connection successful": "连接成功",
        "Connection failed": "连接失败",
        "Select a model": "选择模型",
        "Default model": "默认模型",
        "Fast model": "快速辅助模型",
        "Add model": "添加模型",
        "Edit model": "编辑模型",
        "Remove model": "移除模型",
        "Model ID": "模型 ID",
        "Display name": "显示名称",
        "Description": "描述",
        "Modalities": "模态支持",
        "Vision": "视觉（图片）",
        "Documents": "文档（PDF）",
        "Web tools": "网页工具",
        "Export config": "导出配置",
        "Import config": "导入配置",
        "Reset to default": "恢复默认",
        "Clear diagnostics": "清空诊断日志",
        "Reload extension": "重载扩展",
        "Diagnostics": "运行诊断",
        "Call logs": "请求日志",
        "All sites allowed": "已允许所有网站",
        "Directly allow all sites": "直接允许所有网站",
    }
    translations.update(exact_map)

    # 智能构建 zh-CN 字典
    zh = {}
    for k, text in en.items():
        if text in translations:
            zh[k] = translations[text]
        elif k in translations:
            zh[k] = translations[k]
        else:
            # 常见短语匹配
            t = text
            t = re.sub(r'\bSettings\b', '设置', t)
            t = re.sub(r'\bPermissions\b', '权限', t)
            t = re.sub(r'\bShortcuts\b', '快捷指令', t)
            t = re.sub(r'\bScheduled Tasks\b', '计划任务', t)
            t = re.sub(r'\bAccount\b', '账户', t)
            t = re.sub(r'\bLog in\b', '登录', t)
            t = re.sub(r'\bLog out\b', '退出登录', t)
            t = re.sub(r'\bCancel\b', '取消', t)
            t = re.sub(r'\bDelete\b', '删除', t)
            t = re.sub(r'\bConfirm\b', '确认', t)
            t = re.sub(r'\bClose\b', '关闭', t)
            t = re.sub(r'\bSave\b', '保存', t)
            t = re.sub(r'\bRetry\b', '重试', t)
            t = re.sub(r'\bCopied\b', '已复制', t)
            t = re.sub(r'\bCopy\b', '复制', t)
            t = re.sub(r'\bSearch\b', '搜索', t)
            t = re.sub(r'\bLoading\b', '加载中', t)
            zh[k] = t

    out_path = 'browser-extension/claude-gateway/i18n/zh-CN.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(zh, f, ensure_ascii=False, indent=2)
    print(f'Wrote {len(zh)} keys to {out_path}')

if __name__ == '__main__':
    build_zh_cn()
