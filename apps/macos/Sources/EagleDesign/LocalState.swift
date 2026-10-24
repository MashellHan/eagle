import Combine
import SwiftUI

/// Observable box backing `@LocalState`.
public final class LocalStateStorage<Value>: ObservableObject {
  @Published public var value: Value

  public init(_ value: Value) {
    self.value = value
  }
}

/// Drop-in replacement for `@State` that does not rely on SwiftUI's macro
/// plugin, which is unavailable with a Command Line Tools-only toolchain.
/// Reads and writes trigger the same re-render `@State` would.
@propertyWrapper
public struct LocalState<Value>: DynamicProperty {
  @StateObject private var storage: LocalStateStorage<Value>

  public init(wrappedValue: Value) {
    _storage = StateObject(wrappedValue: LocalStateStorage(wrappedValue))
  }

  public var wrappedValue: Value {
    get { storage.value }
    nonmutating set { storage.value = newValue }
  }

  public var projectedValue: Binding<Value> {
    Binding(
      get: { storage.value },
      set: { storage.value = $0 }
    )
  }
}
