"""The notification email's HTML template (inline-CSS table layout, so it
renders the same in Outlook and Gmail). Identical output regardless of which
delivery provider sends it."""
from jinja2 import Template

EMAIL_TEMPLATE = Template(r'''
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f2f4f7;font-family:Segoe UI, Arial, sans-serif;">
{% if test_mode %}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff3cd;">
  <tr><td style="padding:8px 24px;font-size:12px;color:#664d03;text-align:center;">
    TEST MODE -- This is a sample notification generated for pipeline testing.
  </td></tr>
</table>
{% endif %}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border:1px solid #d0d5dd;border-radius:6px;overflow:hidden;">

        <tr>
          <td style="background-color:#0b2a4a;padding:20px 28px;">
            <span style="color:#ffffff;font-size:16px;font-weight:600;letter-spacing:0.5px;">DGCA REGULATORY INTELLIGENCE UPDATE</span>
          </td>
        </tr>

        <tr>
          <td style="padding:24px 28px 8px 28px;">
            <span style="font-size:19px;font-weight:600;color:#101828;">{{ update.title }}</span>
          </td>
        </tr>

        <tr>
          <td style="padding:4px 28px 20px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;color:#475467;">
              <tr>
                <td style="padding:3px 16px 3px 0;font-weight:600;color:#344054;">Category</td>
                <td style="padding:3px 0;">{{ update.category }}</td>
              </tr>
              <tr>
                <td style="padding:3px 16px 3px 0;font-weight:600;color:#344054;">Published Date</td>
                <td style="padding:3px 0;">{{ update.published_date }}</td>
              </tr>
              <tr>
                <td style="padding:3px 16px 3px 0;font-weight:600;color:#344054;">Effective Date</td>
                <td style="padding:3px 0;">{{ update.effective_date }}</td>
              </tr>
              <tr>
                <td style="padding:3px 16px 3px 0;font-weight:600;color:#344054;">Impact Level</td>
                <td style="padding:3px 0;">
                  <span style="background-color:{{ impact_color }};color:#ffffff;padding:2px 10px;border-radius:3px;font-size:12px;font-weight:600;">{{ update.impact_level }}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr><td style="border-top:1px solid #eaecf0;"></td></tr>

        <tr>
          <td style="padding:20px 28px 8px 28px;">
            <span style="font-size:14px;font-weight:700;color:#101828;">EXECUTIVE SUMMARY</span>
            <p style="font-size:14px;line-height:1.55;color:#344054;margin:10px 0 0 0;">{{ ai_summary }}</p>
          </td>
        </tr>

        {% if update.key_changes %}
        <tr>
          <td style="padding:16px 28px 8px 28px;">
            <span style="font-size:14px;font-weight:700;color:#101828;">KEY CHANGES</span>
            <ul style="margin:10px 0 0 0;padding-left:20px;font-size:14px;line-height:1.6;color:#344054;">
              {% for item in update.key_changes %}<li>{{ item }}</li>{% endfor %}
            </ul>
          </td>
        </tr>
        {% endif %}

        {% if update.impacted_departments %}
        <tr>
          <td style="padding:16px 28px 8px 28px;">
            <span style="font-size:14px;font-weight:700;color:#101828;">IMPACTED DEPARTMENTS</span>
            <ul style="margin:10px 0 0 0;padding-left:20px;font-size:14px;line-height:1.6;color:#344054;">
              {% for dept in update.impacted_departments %}<li>{{ dept }}</li>{% endfor %}
            </ul>
          </td>
        </tr>
        {% endif %}

        {% if update.recommended_actions %}
        <tr>
          <td style="padding:16px 28px 8px 28px;">
            <span style="font-size:14px;font-weight:700;color:#101828;">RECOMMENDED ACTIONS</span>
            <ul style="margin:10px 0 0 0;padding-left:20px;font-size:14px;line-height:1.6;color:#344054;">
              {% for action in update.recommended_actions %}<li>{{ action }}</li>{% endfor %}
            </ul>
          </td>
        </tr>
        {% endif %}

        {% if update.is_update %}
        <tr><td style="border-top:1px solid #eaecf0;"></td></tr>
        <tr>
          <td style="padding:20px 28px 8px 28px;">
            <span style="font-size:14px;font-weight:700;color:#101828;">UPDATED PUBLICATION -- VERSION COMPARISON</span>
            <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;color:#475467;margin-top:10px;">
              <tr>
                <td style="padding:3px 16px 3px 0;font-weight:600;color:#344054;">Previous Version</td>
                <td style="padding:3px 0;">{{ update.previous_title or "Not specified in the publication." }}</td>
              </tr>
              <tr>
                <td style="padding:3px 16px 3px 0;font-weight:600;color:#344054;">Current Version</td>
                <td style="padding:3px 0;">{{ update.title }}</td>
              </tr>
              <tr>
                <td style="padding:3px 16px 3px 0;font-weight:600;color:#344054;">Overall Change Level</td>
                <td style="padding:3px 0;">{{ update.overall_change_level or "NONE" }}</td>
              </tr>
            </table>
            {% if update.added_changes %}
            <p style="font-size:13px;font-weight:600;color:#101828;margin:14px 0 4px 0;">Added</p>
            <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.6;color:#344054;">
              {% for item in update.added_changes %}<li>{{ item }}</li>{% endfor %}
            </ul>
            {% endif %}
            {% if update.removed_changes %}
            <p style="font-size:13px;font-weight:600;color:#101828;margin:14px 0 4px 0;">Removed</p>
            <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.6;color:#344054;">
              {% for item in update.removed_changes %}<li>{{ item }}</li>{% endfor %}
            </ul>
            {% endif %}
            {% if update.modified_changes %}
            <p style="font-size:13px;font-weight:600;color:#101828;margin:14px 0 4px 0;">Modified</p>
            <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.6;color:#344054;">
              {% for item in update.modified_changes %}<li>{{ item }}</li>{% endfor %}
            </ul>
            {% endif %}
            {% if update.comparison_explanation %}
            <p style="font-size:13px;font-weight:600;color:#101828;margin:14px 0 4px 0;">AI Explanation</p>
            <p style="font-size:13px;line-height:1.55;color:#344054;margin:0;">{{ update.comparison_explanation }}</p>
            {% endif %}
          </td>
        </tr>
        {% endif %}

        <tr><td style="border-top:1px solid #eaecf0;padding-top:4px;"></td></tr>

        <tr>
          <td style="padding:20px 28px 28px 28px;">
            <span style="font-size:14px;font-weight:700;color:#101828;">DOCUMENT LINKS</span><br/>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:12px;">
              <tr>
                {% if update.dgca_url %}
                <td style="padding-right:10px;padding-bottom:10px;">
                  <a href="{{ update.dgca_url }}" style="display:inline-block;background-color:#0b2a4a;color:#ffffff;text-decoration:none;font-size:13px;padding:9px 16px;border-radius:4px;">View on DGCA Website</a>
                </td>
                {% endif %}
                {% if update.pdf_url %}
                <td style="padding-bottom:10px;">
                  <a href="{{ update.pdf_url }}" style="display:inline-block;background-color:#0b2a4a;color:#ffffff;text-decoration:none;font-size:13px;padding:9px 16px;border-radius:4px;">Download PDF</a>
                </td>
                {% endif %}
                {% if not update.dgca_url and not update.pdf_url %}
                <td style="padding-bottom:10px;font-size:13px;color:#98a2b3;">No document links available for this publication.</td>
                {% endif %}
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="background-color:#f9fafb;padding:14px 28px;border-top:1px solid #eaecf0;">
            <span style="font-size:11px;color:#98a2b3;">
              DGCA Regulatory Intelligence and Monitoring System -- automated notification generated {{ generated_at }}.
              This is {{ "test/preview" if test_mode else "production" }} output. Verify against the official DGCA publication before acting.
            </span>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>
''')
