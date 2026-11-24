"""Reusable pieces shared by more than one view: status badges and the full
publication-detail layout."""
import streamlit as st

from pipeline import storage
from pipeline.email_pipeline import IMPACT_COLORS


def analysis_mode_badge(mode: str) -> str:
    if mode == "ai-local":
        return '<span class="analysis-badge badge-ai">✓ AI-Generated (local LLM)</span>'
    if mode == "ai-openai":
        return '<span class="analysis-badge badge-ai">✓ AI-Generated (OpenAI)</span>'
    if mode == "degraded":
        return '<span class="analysis-badge badge-degraded">⚠ Degraded (no extracted text)</span>'
    if mode == "fallback":
        return '<span class="analysis-badge badge-fallback">⚠ Deterministic Fallback (no LLM analysis)</span>'
    return '<span class="analysis-badge badge-fallback">Not yet analyzed</span>'


def impact_badge(level: str) -> str:
    color = IMPACT_COLORS.get((level or "").upper(), "#667085")
    label = level or "Not analyzed"
    return f'<span class="analysis-badge" style="background-color:{color};color:#ffffff;">{label}</span>'


def render_comparison(pub: dict, previous_pub: dict) -> None:
    comp = pub["comparison_summary"]
    level = comp.get("overall_change_level", "NONE")
    color = IMPACT_COLORS.get(level.upper(), "#667085") if level.upper() in IMPACT_COLORS else "#475467"

    st.markdown(
        f"**Overall change level:** "
        f'<span class="analysis-badge" style="background-color:{color};color:#fff;">{level}</span>'
        f"&nbsp;&nbsp;**Total changes:** {comp.get('total_changes', 0)}",
        unsafe_allow_html=True,
    )

    col_old, col_new = st.columns(2)
    with col_old:
        st.markdown("**Previous Version**")
        st.caption(previous_pub["title"] if previous_pub else "Unknown")
    with col_new:
        st.markdown("**Current Version**")
        st.caption(pub["title"])

    add_col, rem_col, mod_col = st.columns(3)
    with add_col:
        st.markdown("**➕ Added**")
        for item in comp.get("added", []) or ["None"]:
            st.markdown(f"- {item}")
    with rem_col:
        st.markdown("**➖ Removed**")
        for item in comp.get("removed", []) or ["None"]:
            st.markdown(f"- {item}")
    with mod_col:
        st.markdown("**✏️ Modified**")
        for item in comp.get("modified", []) or ["None"]:
            st.markdown(f"- {item}")

    st.markdown("**AI Explanation (operational impact)**")
    st.info(comp.get("operational_impact", "Not specified in the publication."))


def render_publication_detail(pub: dict, conn) -> None:
    """Publication detail + document actions + AI analysis -- shared by the
    Publications view and (for the synthetic pair) the Comparison view, so
    the layout is identical everywhere a publication is shown in full."""
    st.subheader(pub["title"])

    meta_cols = st.columns(4)
    meta_cols[0].markdown(f"**Category**\n\n{pub['category']}")
    meta_cols[1].markdown(f"**Published**\n\n{pub['published_date'] or 'Not specified in the publication.'}")
    meta_cols[2].markdown(f"**Effective Date**\n\n{pub['effective_date'] or 'Not specified in the publication.'}")
    meta_cols[3].markdown("**Impact Level**\n\n" + impact_badge(pub["impact_level"]), unsafe_allow_html=True)

    st.markdown("##### Document Actions")
    action_cols = st.columns(4)
    if pub.get("publication_url"):
        action_cols[0].link_button("Open DGCA Publication", pub["publication_url"], use_container_width=True)
    else:
        action_cols[0].button("No DGCA link on record", disabled=True, use_container_width=True)

    if pub.get("pdf_url"):
        action_cols[1].link_button("Download New PDF", pub["pdf_url"], use_container_width=True)
    else:
        action_cols[1].button("No PDF on record", disabled=True, use_container_width=True)

    previous_pub = None
    if pub.get("previous_publication_id"):
        previous_pub = storage.get_publication_by_id(conn, pub["previous_publication_id"])
    if previous_pub and previous_pub.get("pdf_url"):
        action_cols[2].link_button("Download Old PDF", previous_pub["pdf_url"], use_container_width=True)
    else:
        action_cols[2].button("No previous version", disabled=True, use_container_width=True)

    has_comparison = bool(pub.get("comparison_summary"))
    action_cols[3].button(
        "View Comparison" if has_comparison else "No comparison available",
        disabled=not has_comparison,
        use_container_width=True,
        key=f"cmp-btn-{pub['publication_id']}",
    )

    st.divider()

    st.markdown('<div class="source-label">AI Analysis</div>', unsafe_allow_html=True)
    st.markdown(analysis_mode_badge(pub["analysis_mode"]), unsafe_allow_html=True)

    st.markdown("**Executive Summary**")
    st.write(pub["ai_summary"] or "Not yet analyzed.")

    col_a, col_b = st.columns(2)
    with col_a:
        st.markdown("**Key Changes**")
        if pub["key_changes"]:
            for kc in pub["key_changes"]:
                st.markdown(f"- {kc}")
        else:
            st.caption("None recorded (first-time publication, or no substantive changes).")

        st.markdown("**Impacted Departments**")
        if pub["impacted_departments"]:
            for dept in pub["impacted_departments"]:
                st.markdown(f"- {dept}")
        else:
            st.caption("Not specified in the publication.")

    with col_b:
        st.markdown("**Recommended Actions**")
        if pub["recommended_actions"]:
            for action in pub["recommended_actions"]:
                st.markdown(f"- {action}")
        else:
            st.caption("None recorded.")

    st.markdown('<div class="source-label" style="margin-top:1rem;">Source Document Information</div>', unsafe_allow_html=True)
    src_cols = st.columns(3)
    src_cols[0].markdown(f"**Status:** {pub['status']}")
    src_cols[1].markdown(f"**Document hash:** {'on record' if pub.get('document_hash') else 'not available'}")
    src_cols[2].markdown(f"**Analyzed at:** {pub.get('analyzed_at') or 'not yet analyzed'}")

    if has_comparison:
        with st.expander("View Old vs New Comparison", expanded=False):
            render_comparison(pub, previous_pub)
