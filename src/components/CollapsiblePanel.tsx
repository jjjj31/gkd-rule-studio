import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

interface CollapsiblePanelProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  defaultCollapsed?: boolean;
  subtitle?: ReactNode;
}

export function CollapsiblePanel({
  title,
  subtitle,
  actions,
  children,
  className,
  defaultCollapsed = false,
}: CollapsiblePanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <section
      className={[
        "panel",
        "collapsible-panel",
        collapsed ? "panel-collapsed" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="panel-title-row">
        <div className="panel-heading">
          <h2>
            <button
              aria-expanded={!collapsed}
              className="panel-collapse-button"
              type="button"
              onClick={() => setCollapsed((current) => !current)}
            >
              <ChevronDown className="panel-collapse-icon" size={15} />
              <span>{title}</span>
            </button>
          </h2>
          {subtitle && <p className="panel-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="panel-header-actions">{actions}</div>}
      </div>
      {!collapsed && <div className="panel-body">{children}</div>}
    </section>
  );
}
