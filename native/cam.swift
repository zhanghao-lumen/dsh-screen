// cam —— 摄像头取帧工具（AVFoundation）
// 用法：
//   cam --list
//   cam --still --out /tmp/a.jpg [--size 960] [--warm 400] [--device <id>]
//   cam --frames 6 --interval-ms 400 --out-dir /tmp/d [--size 960] [--warm 400] [--device <id>]
// 输出：JSONL 到 stdout；每帧一行 {"type":"frame","n":1,"path":"...","w":960,"h":540,"diff":12.3,"at":...}
// 退出码：0 正常；2 没有设备；3 打开设备失败；4 摄像头权限被拒；5 超时没拿到画面
import AVFoundation
import CoreImage
import Foundation

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
  fflush(stdout)
}

func fail(_ code: Int32, _ message: String) -> Never {
  emit(["type": "error", "message": message])
  exit(code)
}

var listOnly = false
var frames = 1
var intervalMs = 400
var outPath = ""
var outDir = ""
var size = 960
var warmMs = 400
var deviceID: String? = nil

var it = CommandLine.arguments.dropFirst().makeIterator()
while let arg = it.next() {
  switch arg {
  case "--list": listOnly = true
  case "--still": frames = 1
  case "--frames": frames = Int(it.next() ?? "1") ?? 1
  case "--interval-ms": intervalMs = Int(it.next() ?? "400") ?? 400
  case "--out": outPath = it.next() ?? ""
  case "--out-dir": outDir = it.next() ?? ""
  case "--size": size = Int(it.next() ?? "960") ?? 960
  case "--warm": warmMs = Int(it.next() ?? "400") ?? 400
  case "--device": deviceID = it.next()
  default: break
  }
}

let discovery = AVCaptureDevice.DiscoverySession(
  deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera],
  mediaType: .video,
  position: .unspecified)

if listOnly {
  let list = discovery.devices.map { d -> [String: Any] in
    ["id": d.uniqueID, "name": d.localizedName, "model": d.modelID]
  }
  emit(["type": "devices", "devices": list])
  exit(0)
}

guard let device = deviceID.flatMap({ AVCaptureDevice(uniqueID: $0) }) ?? discovery.devices.first else {
  fail(2, "没有找到摄像头")
}

// 权限：先查状态，未决定就请求（最多等 8 秒）
let status = AVCaptureDevice.authorizationStatus(for: .video)
if status == .denied || status == .restricted {
  fail(4, "摄像头权限被拒绝：请在 系统设置 → 隐私与安全性 → 摄像头 里允许当前应用")
}
if status == .notDetermined {
  let sem = DispatchSemaphore(value: 0)
  var granted = false
  AVCaptureDevice.requestAccess(for: .video) { ok in granted = ok; sem.signal() }
  if sem.wait(timeout: .now() + 8) == .timedOut {
    fail(4, "等待摄像头授权超时：可能有一个授权弹窗在等你点")
  }
  if !granted { fail(4, "摄像头权限被拒绝") }
}

let session = AVCaptureSession()
session.beginConfiguration()
session.sessionPreset = size >= 1280 ? .hd1280x720 : .vga640x480
do {
  let input = try AVCaptureDeviceInput(device: device)
  guard session.canAddInput(input) else { fail(3, "无法添加摄像头输入") }
  session.addInput(input)
} catch {
  fail(3, "打开摄像头失败：\(error.localizedDescription)")
}

let output = AVCaptureVideoDataOutput()
output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)]
output.alwaysDiscardsLateVideoFrames = true
guard session.canAddOutput(output) else { fail(3, "无法添加视频输出") }
session.addOutput(output)
session.commitConfiguration()

let dir: URL
if frames == 1 && !outPath.isEmpty {
  dir = URL(fileURLWithPath: outPath).deletingLastPathComponent()
} else {
  guard !outDir.isEmpty else { fail(3, "需要 --out 或 --out-dir") }
  dir = URL(fileURLWithPath: outDir)
}
try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

final class Grabber: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  let maxFrames: Int
  let interval: TimeInterval
  let dir: URL
  let width: Int
  let single: String
  let readyAt = Date().addingTimeInterval(Double(warmMs) / 1000.0)
  let ci = CIContext(options: [.useSoftwareRenderer: false])
  var lastAt = Date.distantPast
  var n = 0
  var prev: [Double]?

  init(maxFrames: Int, intervalMs: Int, dir: URL, width: Int, single: String) {
    self.maxFrames = maxFrames
    self.interval = Double(intervalMs) / 1000.0
    self.dir = dir
    self.width = width
    self.single = single
  }

  func thumb(_ buffer: CVPixelBuffer) -> [Double] {
    let image = CIImage(cvPixelBuffer: buffer)
    let scale = 16.0 / Double(max(CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer)))
    let small = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    var pixels = [UInt8](repeating: 0, count: 16 * 16 * 4)
    let rect = CGRect(x: 0, y: 0, width: 16, height: 16)
    ci.render(small, toBitmap: &pixels, rowBytes: 16 * 4, bounds: rect, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
    var gray = [Double](repeating: 0, count: 16 * 16)
    for i in 0..<(16 * 16) {
      let r = Double(pixels[i * 4]), g = Double(pixels[i * 4 + 1]), b = Double(pixels[i * 4 + 2])
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b
    }
    return gray
  }

  func write(_ buffer: CVPixelBuffer, to url: URL) -> Bool {
    let image = CIImage(cvPixelBuffer: buffer)
    let w = Double(CVPixelBufferGetWidth(buffer))
    let scaled = image.transformed(by: CGAffineTransform(scaleX: Double(width) / w, y: Double(width) / w))
    guard let data = ci.jpegRepresentation(of: scaled, colorSpace: CGColorSpaceCreateDeviceRGB()) else { return false }
    return (try? data.write(to: url)) != nil
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    let now = Date()
    guard now >= readyAt, now.timeIntervalSince(lastAt) >= interval else { return }
    guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    lastAt = now
    let gray = thumb(buffer)
    var diff: Double = 0
    if let prev = prev {
      var sum = 0.0
      for i in 0..<gray.count { sum += abs(gray[i] - prev[i]) }
      diff = sum / Double(gray.count)
    }
    prev = gray
    n += 1
    let url = single.isEmpty ? dir.appendingPathComponent(String(format: "f%02d.jpg", n)) : URL(fileURLWithPath: single)
    guard write(buffer, to: url) else { return }
    emit(["type": "frame", "n": n, "path": url.path,
          "w": CVPixelBufferGetWidth(buffer), "h": CVPixelBufferGetHeight(buffer),
          "diff": (diff * 10).rounded() / 10, "at": now.timeIntervalSince1970])
    if n >= maxFrames { exit(0) }
  }
}

let grabber = Grabber(maxFrames: frames, intervalMs: intervalMs, dir: dir, width: size, single: frames == 1 ? outPath : "")
let queue = DispatchQueue(label: "dsh.cam")
output.setSampleBufferDelegate(grabber, queue: queue)

session.startRunning()
let deadline = Date().addingTimeInterval(Double(warmMs) / 1000.0 + Double(frames) * (Double(intervalMs) / 1000.0) + 6.0)
while Date() < deadline {
  RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}
session.stopRunning()
fail(5, "超时：没拿到画面（相机被别的应用占用？）")
