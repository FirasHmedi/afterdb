# Design note: SwiftPM (React Native 0.89)

React Native 0.89 is expected to make Swift Package Manager the default for iOS dependencies. Not implemented yet.

Plan: a `Package.swift` at the package root with
- a `binaryTarget` pointing at `prebuilds/apple/realm-core.xcframework`;
- a C++20 target for the binding (`binding/jsi`, `binding/apple`, `bindgen/src`) with the same header search paths
  and flags as `RealmJS.podspec`, depending on the React Native SwiftPM products that provide JSI and TurboModules;
- the `PrivacyInfo.xcprivacy` resource.

Most of the work is matching React Native's own SwiftPM layout once 0.89 ships.
