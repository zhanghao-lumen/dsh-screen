// dsh-screen 录音器：把麦克风录成 16k 单声道 WAV，转写交给本地 whisper。
// 只用麦克风权限（DSH 的 Info.plist 已声明 NSMicrophoneUsageDescription），不碰语音识别权限。
import AVFoundation
import Foundation

var spoolPath = ""
var wavPath = ""
var stopFile: String?
var seconds: Double = 45

var it = CommandLine.arguments.dropFirst().makeIterator()
while let flag = it.next() {
    switch flag {
    case "--spool": spoolPath = it.next() ?? ""
    case "--out": wavPath = it.next() ?? ""
    case "--stop-file": stopFile = it.next()
    case "--seconds": seconds = Double(it.next() ?? "") ?? seconds
    default: break
    }
}
guard !spoolPath.isEmpty, !wavPath.isEmpty else {
    FileHandle.standardError.write("需要 --spool 和 --out\n".data(using: .utf8)!)
    exit(64)
}
FileManager.default.createFile(atPath: spoolPath, contents: nil)
let spool = try! FileHandle(forWritingTo: URL(fileURLWithPath: spoolPath))

func emit(_ type: String, _ extra: [String: Any] = [:]) {
    var payload: [String: Any] = ["type": type, "t": Int(Date().timeIntervalSince1970 * 1000)]
    for (k, v) in extra { payload[k] = v }
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    spool.write(data)
    spool.write("\n".data(using: .utf8)!)
}

let sampleRate: Double = 16000
let fileSettings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: sampleRate,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
]
var file: AVAudioFile? = try? AVAudioFile(forWriting: URL(fileURLWithPath: wavPath), settings: fileSettings)
guard file != nil else {
    emit("error", ["message": "无法写入 \(wavPath)"]); exit(6)
}
let engine = AVAudioEngine()
var stopping = false
var frames: AVAudioFramePosition = 0

func finish(_ reason: String) {
    guard !stopping else { return }
    stopping = true
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    file = nil // 让 AVAudioFile 收尾写头
    let secs = sampleRate > 0 ? Double(frames) / sampleRate : 0
    emit("final", ["reason": reason, "seconds": (secs * 10).rounded() / 10, "file": wavPath])
    emit("done")
    try? spool.close()
    CFRunLoopStop(CFRunLoopGetMain())
}

AVCaptureDevice.requestAccess(for: .audio) { granted in
    DispatchQueue.main.async {
        emit("mic", ["granted": granted])
        guard granted else {
            emit("error", ["message": "麦克风权限未授予（系统设置 → 隐私与安全性 → 麦克风）"]); exit(3)
        }
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        let target = file?.processingFormat
        guard let target, let converter = AVAudioConverter(from: inputFormat, to: target) else {
            emit("error", ["message": "无法创建重采样器"]); exit(8)
        }
        let ratio = target.sampleRate / inputFormat.sampleRate
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var fed = false
            var err: NSError?
            converter.convert(to: out, error: &err) { _, status in
                if fed {
                    status.pointee = .noDataNow
                    return nil
                }
                fed = true
                status.pointee = .haveData
                return buffer
            }
            if err == nil, out.frameLength > 0, let sink = file {
                try? sink.write(from: out)
                frames += AVAudioFramePosition(out.frameLength)
            }
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            emit("error", ["message": "麦克风打不开：\(error.localizedDescription)"]); exit(7)
        }
        emit("recording")
        Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { _ in
            if let marker = stopFile, FileManager.default.fileExists(atPath: marker) { finish("user") }
            if Double(frames) / sampleRate >= seconds { finish("timeout") }
        }
    }
}

RunLoop.main.run()
