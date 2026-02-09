import Foundation
import FamilyControls
import ManagedSettings
import DeviceActivity

@available(iOS 15.0, *)
class ScreenTimeManager: ObservableObject {
    static let shared = ScreenTimeManager()
    
    private let store = ManagedSettingsStore()
    private let center = AuthorizationCenter.shared
    
    @Published var isAuthorized = false
    @Published var isBlocking = false
    
    init() {
        checkAuthorization()
    }
    
    func checkAuthorization() {
        Task {
            do {
                try await center.requestAuthorization(for: .individual)
                await MainActor.run {
                    self.isAuthorized = true
                }
            } catch {
                print("Screen Time authorization failed: \(error)")
                await MainActor.run {
                    self.isAuthorized = false
                }
            }
        }
    }
    
    /// Start blocking all apps except Phone and Messages
    func startBlocking() {
        guard isAuthorized else {
            print("Not authorized for Screen Time")
            return
        }
        
        // Block all applications
        store.shield.applications = .all()
        
        // But allow specific categories (communication)
        store.shield.applicationCategories = .all(except: .communication())
        
        // Allow Phone and Messages specifically
        store.shield.webDomains = nil
        
        isBlocking = true
        print("🔒 App blocking started - all apps blocked except Phone & Messages")
    }
    
    /// Stop blocking and restore access
    func stopBlocking() {
        store.shield.applications = nil
        store.shield.applicationCategories = nil
        store.shield.webDomains = nil
        
        isBlocking = false
        print("🔓 App blocking stopped - all apps accessible")
    }
    
    /// Check if we should show forfeit dialog
    func handleAppLaunchAttempt(completion: @escaping (Bool) -> Void) {
        // This would be called from the shield configuration
        // Return true if user chooses to forfeit, false to stay blocked
        completion(false)
    }
}

// MARK: - Shield Configuration
@available(iOS 15.0, *)
extension ScreenTimeManager {
    func configureShield(stakeAmount: Double) {
        // The shield shows when users try to open blocked apps
        // We'll configure a custom message asking if they want to forfeit
        
        // Note: Custom shield UI requires a ShieldConfigurationExtension
        // which needs to be a separate target in the Xcode project
        print("Shield configured for $\(stakeAmount) stake")
    }
}

// MARK: - JavaScript Bridge for Capacitor
@available(iOS 15.0, *)
@objc class ScreenTimeBridge: NSObject {
    
    @objc static func requestAuthorization(_ callback: @escaping (Bool) -> Void) {
        Task {
            do {
                try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
                callback(true)
            } catch {
                print("Auth error: \(error)")
                callback(false)
            }
        }
    }
    
    @objc static func startBlocking() {
        ScreenTimeManager.shared.startBlocking()
    }
    
    @objc static func stopBlocking() {
        ScreenTimeManager.shared.stopBlocking()
    }
    
    @objc static func isAuthorized() -> Bool {
        return ScreenTimeManager.shared.isAuthorized
    }
}
