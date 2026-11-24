"""Minimal, restrained styling -- readability and hierarchy over decoration."""

PAGE_CSS = """
<style>
.block-container { padding-top: 2rem; padding-bottom: 2rem; }
.stMetric { background-color: rgba(11, 42, 74, 0.04); border-radius: 6px; padding: 0.75rem; }
.analysis-badge {
    display: inline-block; padding: 3px 10px; border-radius: 4px;
    font-size: 12px; font-weight: 600; letter-spacing: 0.3px;
}
.badge-ai { background-color: #dcfce7; color: #166534; }
.badge-fallback { background-color: #fef3c7; color: #92400e; }
.badge-degraded { background-color: #fee2e2; color: #991b1b; }
.source-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
    color: #667085; font-weight: 600; margin-bottom: 2px;
}
</style>
"""
