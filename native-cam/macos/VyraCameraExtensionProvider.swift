// VYRANI AI Native Virtual Camera for macOS (CoreMediaIO Camera System Extension).
// Exposes "VYRANI AI Camera" (1280x720 @ 30fps) to FaceTime, Zoom, WhatsApp Desktop, Discord, and Browsers
// without OBS by reading frames from /tmp/vyra_cam.shm populated by vyra_cam_bridge.py.

import Foundation
import CoreMediaIO
import CoreVideo
import IOKit.audio

let kVyraWidth = 1280
let kVyraHeight = 720
let kVyraFPS = 30
let kShmPath = "/tmp/vyra_cam.shm"
let kHeaderSize = 28
let kFrameBytes = kVyraWidth * kVyraHeight * 3

final class VyraStreamSource: NSObject, CMIOExtensionStreamSource {
    private(set) var stream: CMIOExtensionStream!
    private let device: CMIOExtensionDevice
    private let streamFormat: CMIOExtensionStreamFormat
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "ai.vyra.camera.stream", qos: .userInteractive)

    init(localizedName: String, streamID: UUID, streamFormat: CMIOExtensionStreamFormat, device: CMIOExtensionDevice) {
        self.device = device
        self.streamFormat = streamFormat
        super.init()
        self.stream = CMIOExtensionStream(localizedName: localizedName, streamID: streamID, direction: .source, clockType: .hostTime, source: self)
    }

    var formats: [CMIOExtensionStreamFormat] { [streamFormat] }
    var activeFormatIndex: Int = 0
    var availableProperties: Set<CMIOExtensionProperty> { [.streamActiveFormatIndex, .streamFrameDuration] }

    func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
        let props = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) { props.activeFormatIndex = 0 }
        if properties.contains(.streamFrameDuration) { props.frameDuration = CMTime(value: 1, timescale: Int32(kVyraFPS)) }
        return props
    }

    func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {}
    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool { true }

    func startStream() throws {
        let t = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
        t.schedule(deadline: .now(), repeating: 1.0 / Double(kVyraFPS))
        t.setEventHandler { [weak self] in self?.emitFrame() }
        t.resume()
        timer = t
    }

    func stopStream() throws {
        timer?.cancel()
        timer = nil
    }

    private func emitFrame() {
        var pixelBuffer: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:]
        ]
        guard CVPixelBufferCreate(kCFAllocatorDefault, kVyraWidth, kVyraHeight, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pixelBuffer) == kCVReturnSuccess,
              let pb = pixelBuffer else { return }

        CVPixelBufferLockBaseAddress(pb, [])
        if let base = CVPixelBufferGetBaseAddress(pb) {
            let dst = base.assumingMemoryBound(to: UInt8.self)
            let bytesPerRow = CVPixelBufferGetBytesPerRow(pb)
            if let data = try? Data(contentsOf: URL(fileURLWithPath: kShmPath), options: .mappedIfSafe),
               data.count >= kHeaderSize + kFrameBytes {
                data.withUnsafeBytes { raw in
                    guard let src = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
                    let rgb = src.advanced(by: kHeaderSize)
                    for y in 0..<kVyraHeight {
                        let rowDst = dst.advanced(by: y * bytesPerRow)
                        let rowSrc = rgb.advanced(by: y * kVyraWidth * 3)
                        for x in 0..<kVyraWidth {
                            rowDst[x * 4 + 0] = rowSrc[x * 3 + 2] // B
                            rowDst[x * 4 + 1] = rowSrc[x * 3 + 1] // G
                            rowDst[x * 4 + 2] = rowSrc[x * 3 + 0] // R
                            rowDst[x * 4 + 3] = 255               // A
                        }
                    }
                }
            }
        }
        CVPixelBufferUnlockBaseAddress(pb, [])

        var formatDesc: CMFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pb, formatDescriptionOut: &formatDesc)
        guard let desc = formatDesc else { return }

        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: Int32(kVyraFPS)),
            presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
            decodeTimeStamp: .invalid
        )
        var sampleBuffer: CMSampleBuffer?
        CMSampleBufferCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pb, dataReady: true, makeDataReadyCallback: nil, refcon: nil, formatDescription: desc, sampleTiming: &timing, sampleBufferOut: &sampleBuffer)
        if let sb = sampleBuffer {
            stream.send(sb, discontinuity: [], hostTimeInNanoseconds: UInt64(timing.presentationTimeStamp.seconds * Double(NSEC_PER_SEC)))
        }
    }
}
