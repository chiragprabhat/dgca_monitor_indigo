from .results import PublicationPipelineResult


def print_pipeline_result(result: PublicationPipelineResult) -> None:
    header = "PIPELINE SUCCESS" if result.status == "success" else f"PIPELINE {result.status.upper()}"
    print(header)
    print(f"Publication: {result.title}")
    print(f"Published: {result.published_date}")
    print("Comparison:")
    print(f"  {result.comparison_status}")
    impact_display = result.impact_level if result.impact_level else "n/a"
    print(f"Impact: {impact_display}")
    summary_preview = result.summary[:220] + ("..." if len(result.summary) > 220 else "")
    print(f"Summary: {summary_preview}")
    if result.status == "success":
        print("Email:")
        print("  Generated successfully")
    else:
        error_display = result.error if result.error else "not sent"
        print("Email:")
        print(f"  {error_display}")
    print("Database:")
    print("  Processing status updated")
