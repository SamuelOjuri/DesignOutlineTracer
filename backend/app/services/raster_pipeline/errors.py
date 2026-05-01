class RasterPipelineError(RuntimeError):
    code = "RasterPipelineError"


class RasterRenderTooLarge(RasterPipelineError):
    code = "RasterRenderTooLarge"


class RasterOcrBudgetExceeded(RasterPipelineError):
    code = "RasterOcrBudgetExceeded"


class FalconSegmentationBudgetExceeded(RasterPipelineError):
    code = "FalconSegmentationBudgetExceeded"


class FalconSegmentationUnavailable(RasterPipelineError):
    code = "FalconSegmentationUnavailable"


class FalconSegmentationTimeout(RasterPipelineError):
    code = "FalconSegmentationTimeout"


class ScaleCalibrationRequired(RasterPipelineError):
    code = "ScaleCalibrationRequired"


class RasterApprovalRequired(RasterPipelineError):
    code = "RasterApprovalRequired"
