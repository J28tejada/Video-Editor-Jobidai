import ExpoModulesCore

final class InvalidCompositionException: GenericException<String> {
  override var reason: String { "Invalid composition: \(param)" }
}

final class MediaLoadException: GenericException<String> {
  override var reason: String { "Could not load media: \(param)" }
}

final class ExportFailedException: GenericException<String> {
  override var reason: String { "Export failed: \(param)" }
}

final class ExportCancelledException: Exception {
  override var reason: String { "Export cancelled" }
}

final class ExportInProgressException: Exception {
  override var reason: String { "Another export is already running" }
}
