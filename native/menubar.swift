// dsh-screen 菜单栏小程序
//
// 一个常驻菜单栏的状态入口：显示学习模式开关、最近一次观察时间、笔记条数，
// 点击即可开关，不依赖 DeepSeek Harness 的页面是否打开。
//
// 编译：
//   swiftc -O -swift-version 5 native/menubar.swift -o native/bin/dsh-screen-menubar \
//     -framework AppKit
//
// 查找宿主端口的顺序：
//   1. $DSH_HOME/dsh-screen.api.json（插件启动时写的，最准）
//   2. 已缓存的端口
//   3. lsof 找 DeepSeek Harness 进程监听的端口，逐个试探 /dsh-screen-api/state

import AppKit
import Carbon.HIToolbox
import Foundation

let apiPath = "/dsh-screen-api/state"

func dshHome() -> String {
    if let value = ProcessInfo.processInfo.environment["DSH_HOME"], !value.isEmpty { return value }
    return NSHomeDirectory() + "/.dsh"
}

struct HostState: Decodable {
    let enabled: Bool
    let intervalMs: Int
    let notes: Int
    let freshMs: Int?
    let changes: Int?
    let boundSession: String?
    let commands: [String]?
}

/// 从插件写的端口文件里读端口。
func portFromFile() -> Int? {
    let path = dshHome() + "/dsh-screen.api.json"
    guard let data = FileManager.default.contents(atPath: path),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let port = object["port"] as? Int, port > 0
    else { return nil }
    return port
}

/// 用 lsof 找出 DeepSeek Harness 正在监听的端口。
func portsFromLsof() -> [Int] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    process.arguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-c", "DeepSeek"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { return [] }
    process.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let text = String(data: data, encoding: .utf8) ?? ""
    var ports: [Int] = []
    for line in text.split(separator: "\n") {
        // 形如：node  1234 zhanghao  21u  IPv4 0x...  TCP 127.0.0.1:61692 (LISTEN)
        guard let range = line.range(of: "127.0.0.1:", options: .backwards) else { continue }
        let tail = line[range.upperBound...]
        let digits = tail.prefix { $0.isNumber }
        if let port = Int(digits), port > 0, !ports.contains(port) { ports.append(port) }
    }
    return ports
}

/// 无磁盘缓存的会话，避免在沙箱里写 ~/Library/Caches。
let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.timeoutIntervalForRequest = 2
    return URLSession(configuration: config)
}()

func getJSON(port: Int, completion: @escaping (HostState?) -> Void) {
    guard let url = URL(string: "http://127.0.0.1:\(port)\(apiPath)") else { return completion(nil) }
    var request = URLRequest(url: url)
    request.timeoutInterval = 2
    session.dataTask(with: request) { data, _, _ in
        guard let data else { return completion(nil) }
        completion(try? JSONDecoder().decode(HostState.self, from: data))
    }.resume()
}

func postEnabled(port: Int, enabled: Bool, completion: @escaping (Bool) -> Void) {
    guard let url = URL(string: "http://127.0.0.1:\(port)\(apiPath)") else { return completion(false) }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = 4
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["enabled": enabled])
    session.dataTask(with: request) { _, response, _ in
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        completion((200..<300).contains(code))
    }.resume()
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var port: Int?
    private var state: HostState?
    private var lastError: String?
    private var timer: Timer?
    private var hotKeyRef: EventHotKeyRef?

    /// 注册 ⌥⌘D 全局快捷键，菜单栏图标被折叠时也能开关。
    private func installHotKey() {
        let id = EventHotKeyID(signature: OSType(0x44534853), id: 1)  // 'DSHS'
        let status = RegisterEventHotKey(
            UInt32(kVK_ANSI_D),
            UInt32(optionKey | cmdKey),
            id,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
        log("快捷键 ⌥⌘D 注册\(status == noErr ? "成功" : "失败(\(status))")")
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return noErr }
            let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { delegate.toggleStudy() }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
    }

    /// 极简日志：菜单栏里有 Bug 时至少能看到发生了什么。
    private func log(_ message: String) {
        let path = dshHome() + "/dsh-screen-menubar.log"
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            handle.closeFile()
        } else {
            try? line.write(toFile: path, atomically: true, encoding: .utf8)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: 78)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "display", accessibilityDescription: "DSH 屏幕观察")
            button.image?.isTemplate = true
            button.imagePosition = .imageLeading
            button.title = " DSH 屏"
            button.font = NSFont.systemFont(ofSize: 12)
        }
        log("启动：statusItem 创建\(statusItem == nil ? "失败" : "成功")，button=\(statusItem.button == nil ? "nil" : "ok")")
        installHotKey()
        rebuildMenu()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        RunLoop.current.add(timer!, forMode: .common)
    }

    private func refresh() {
        resolvePort { [weak self] port in
            guard let self else { return }
            guard let port else {
                self.port = nil
                self.state = nil
                self.lastError = "找不到正在运行的 DeepSeek Harness"
                self.render()
                return
            }
            self.port = port
            getJSON(port: port) { state in
                DispatchQueue.main.async {
                    self.state = state
                    self.lastError = state == nil ? "宿主在 \(port) 上无响应" : nil
                    self.render()
                }
            }
        }
    }

    private func resolvePort(_ completion: @escaping (Int?) -> Void) {
        if let port = portFromFile() {
            getJSON(port: port) { state in
                if state != nil { return completion(port) }
                self.probe(ports: portsFromLsof(), completion)
            }
            return
        }
        if let port, let _ = state { return completion(port) }
        probe(ports: portsFromLsof(), completion)
    }

    private func probe(ports: [Int], _ completion: @escaping (Int?) -> Void) {
        guard let first = ports.first else { return completion(nil) }
        getJSON(port: first) { state in
            if state != nil { return completion(first) }
            self.probe(ports: Array(ports.dropFirst()), completion)
        }
    }

    private func render() {
        guard let button = statusItem.button else { return }
        if let state {
            let mark = state.enabled ? "●" : "○"
            button.title = " \(mark) 屏幕"
            button.toolTip = state.enabled
                ? "学习模式已开启 · 每 \(state.intervalMs / 1000) 秒观察一次"
                : "学习模式未开启 · 点击开启"
        } else {
            button.title = " ⚠"
            button.toolTip = lastError
        }
        button.image?.isTemplate = true
        let frame = button.window?.frame ?? .zero
        log("渲染：title=\(button.title) visible=\(statusItem.isVisible) frame=\(Int(frame.origin.x)),\(Int(frame.origin.y)) \(Int(frame.width))x\(Int(frame.height))")
        rebuildMenu()
    }

    private func rebuildMenu() {
        let menu = NSMenu()

        let header = NSMenuItem(title: headerText(), action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        let detail = NSMenuItem(title: detailText(), action: nil, keyEquivalent: "")
        detail.isEnabled = false
        menu.addItem(detail)
        menu.addItem(.separator())

        if let port {
            let toggle = NSMenuItem(
                title: (state?.enabled ?? false) ? "停止学习模式" : "开启学习模式",
                action: #selector(toggleStudy),
                keyEquivalent: "t"
            )
            toggle.target = self
            toggle.isEnabled = state != nil
            menu.addItem(toggle)

            let open = NSMenuItem(title: "打开 DeepSeek Harness", action: #selector(openApp), keyEquivalent: "o")
            open.target = self
            menu.addItem(open)

            let page = NSMenuItem(title: "在浏览器打开控制台", action: #selector(openBrowser), keyEquivalent: "b")
            page.target = self
            menu.addItem(page)

            let hint = NSMenuItem(title: "快捷键：⌥⌘D 开关", action: nil, keyEquivalent: "")
            hint.isEnabled = false
            menu.addItem(hint)

            let portItem = NSMenuItem(title: "宿主端口 \(port)", action: nil, keyEquivalent: "")
            portItem.isEnabled = false
            menu.addItem(portItem)
        } else {
            let retry = NSMenuItem(title: "重试连接", action: #selector(retry), keyEquivalent: "r")
            retry.target = self
            menu.addItem(retry)
            if let lastError {
                let errorItem = NSMenuItem(title: lastError, action: nil, keyEquivalent: "")
                errorItem.isEnabled = false
                menu.addItem(errorItem)
            }
        }

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出菜单栏", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
    }

    private func headerText() -> String {
        guard let state else { return lastError ?? "未连接" }
        return state.enabled ? "学习模式：已开启" : "学习模式：未开启"
    }

    private func detailText() -> String {
        guard let state else { return "点「重试连接」再试一次" }
        var parts: [String] = []
        parts.append("每 \(state.intervalMs / 1000) 秒观察")
        if let fresh = state.freshMs { parts.append("画面 \(fresh / 1000) 秒前") }
        parts.append("笔记 \(state.notes) 条")
        if let changes = state.changes, changes > 0 { parts.append("变化 \(changes) 次") }
        if state.boundSession == nil { parts.append("未绑定会话") }
        return parts.joined(separator: " · ")
    }

    @objc private func toggleStudy() {
        guard let port else { return }
        let next = !(state?.enabled ?? false)
        postEnabled(port: port, enabled: next) { ok in
            DispatchQueue.main.async {
                if !ok { NSSound.beep() }
                self.refresh()
            }
        }
    }

    @objc private func openApp() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-a", "DeepSeek Harness"]
        try? process.run()
    }

    @objc private func openBrowser() {
        guard let port, let url = URL(string: "http://127.0.0.1:\(port)/") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func retry() { refresh() }

    @objc private func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
