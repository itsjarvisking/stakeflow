import Capacitor
import FamilyControls

@available(iOS 15.0, *)
@objc(ScreenTimePlugin)
public class ScreenTimePlugin: CAPPlugin {
    
    @objc func requestAuthorization(_ call: CAPPluginCall) {
        Task {
            do {
                try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
                call.resolve(["authorized": true])
            } catch {
                call.resolve(["authorized": false, "error": error.localizedDescription])
            }
        }
    }
    
    @objc func startBlocking(_ call: CAPPluginCall) {
        ScreenTimeManager.shared.startBlocking()
        call.resolve(["success": true])
    }
    
    @objc func stopBlocking(_ call: CAPPluginCall) {
        ScreenTimeManager.shared.stopBlocking()
        call.resolve(["success": true])
    }
    
    @objc func isAuthorized(_ call: CAPPluginCall) {
        call.resolve(["authorized": ScreenTimeManager.shared.isAuthorized])
    }
    
    @objc func isBlocking(_ call: CAPPluginCall) {
        call.resolve(["blocking": ScreenTimeManager.shared.isBlocking])
    }
}
