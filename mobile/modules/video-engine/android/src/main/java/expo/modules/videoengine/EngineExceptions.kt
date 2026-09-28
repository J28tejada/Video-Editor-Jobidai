package expo.modules.videoengine

import expo.modules.kotlin.exception.CodedException

class InvalidCompositionException(detail: String) :
  CodedException("Invalid composition: $detail")

class MediaLoadException(detail: String) :
  CodedException("Could not load media: $detail")

class ExportFailedException(detail: String, cause: Throwable? = null) :
  CodedException("Export failed: $detail", cause)

class ExportCancelledException : CodedException("Export cancelled")

class ExportInProgressException : CodedException("Another export is already running")
