// VYRANI AI — CoreMediaIO Camera Extension: provider + device scaffolding.
//
// This file mirrors the structure of Apple's published walkthrough
// ("Creating a camera extension with Core Media I/O", WWDC22 session 10022 and the
// accompanying sample). It CANNOT be built from the command line: a CMIO camera
// extension must live inside its containing .app at Contents/Library/SystemExtensions,
// be app-sandboxed, be Developer ID-signed + notarized ($99/yr Apple Developer
// Program), and be approved by the user. See BUILD-SIGN-NOTARIZE.md in this folder for
// the complete Xcode project, entitlements, Info.plist keys, and signing steps.
//
// Frame feed: VyraStreamSource (VyraCameraExtensionProvider.swift) reads frames from the
// VYRANI bridge. A sandboxed system extension cannot read /tmp; production builds must
// publish frames into the shared App Group container (group.ai.vyra.camera) from a
// VYRANI helper running in the user session, and read them here. /tmp is kept only as a
// documented dev-mode fallback for unsandboxed drafts (`systemextensionsctl developer on`).

import Foundation
import CoreMediaIO

let kVyraCameraName = "VYRANI AI Camera"
let kVyraDeviceUUID = UUID(uuidString: "9D71A6E6-6D26-4B2A-829A-B0F2A15B1A31")!
let kVyraStreamUUID = UUID(uuidString: "7F36E283-C186-4229-9F5F-81740F86C62B")!
let kVyraAppGroupID = "group.ai.vyra.camera"

final class VyraDeviceProvider: NSObject, CMIOExtensionProviderSource {
    private(set) var provider: CMIOExtensionProvider!
    private(set) var device: CMIOExtensionDevice!

    init(_ provider: CMIOExtensionProvider) {
        self.provider = provider
        device = CMIOExtensionDevice(localizedName: kVyraCameraName,
                                     deviceID: kVyraDeviceUUID,
                                     legacyDeviceID: nil,
                                     provider: provider)
        super.init()
        provider.connectDevice(device)

        let source = VyraStreamSource(localizedName: kVyraCameraName,
                                      streamID: kVyraStreamUUID,
                                      streamFormat: VyraDeviceProvider.streamFormat,
                                      device: device)
        device.addStream(source.stream)
    }

    /// Advertised capture format: 1280x720 4:2:2 YCbCr 8-bit at 30 fps.
    /// Note: the sample generator in VyraCameraExtensionProvider.swift publishes 32-BGRA
    /// image buffers; align the advertised codec between the two files before shipping
    /// (see the format comment there).
    class var streamFormat: CMIOExtensionStreamFormat {
        var formatDesc: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreate(allocator: kCFAllocatorDefault,
                                       codecType: kCMVideoCodecType_422YpCbCr8,
                                       width: 1280,
                                       height: 720,
                                       extensions: nil,
                                       formatDescriptionOut: &formatDesc)
        return CMIOExtensionStreamFormat(formatDescription: formatDesc!,
                                         maxFrameDuration: CMTime(value: 1, timescale: 30),
                                         minFrameDuration: CMTime(value: 1, timescale: 30))
    }

    // MARK: - CMIOExtensionProviderSource conformance

    var devices: [CMIOExtensionDevice] { [device] }

    func start(_ device: CMIOExtensionDevice) throws {
        // No provider-level action needed; the stream source handles per-stream start.
    }

    func stop(_ device: CMIOExtensionDevice) throws {
        // The stream source cancels its timer on stopStream().
    }
}
