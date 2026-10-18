/**
 * Layout-only stylesheet for the 1flowbase settings page. Controls, form
 * fields, modals, menus, and tabs come from the shell's UI primitives, so this
 * file never restates their geometry, color, or focus treatment; it only places
 * the page's own rows, cards, and panels and uses the page-level tokens.
 */
export const STYLES = `
.fb-section{box-sizing:border-box;max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}
.fb-section *{box-sizing:border-box}
.fb-section h2{margin:0;font-size:16px;line-height:24px;font-weight:500}
.fb-hint{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.fb-spacer{flex:1}
.fb-count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.fb-error,.fb-ok,.fb-warn{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l2);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.fb-ok{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-settings-card-fill)}
.fb-warn{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-primary)}
.fb-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.fb-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fb-empty{margin:0;padding:12px 0;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.fb-empty-card{display:flex;flex-direction:column;align-items:center;gap:4px;padding:20px 16px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.fb-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.fb-row{display:flex;align-items:center;gap:8px;padding:12px 14px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.fb-row:focus-within{border-color:var(--dsw-alias-brand-primary)}
.fb-row-open{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.fb-row-open:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.fb-row-head{display:flex;align-items:center;gap:6px;min-width:0}
.fb-row-name{font-size:14px;line-height:22px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fb-row-open:hover .fb-row-name{color:var(--dsw-alias-brand-primary)}
.fb-row-meta{display:block;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fb-row-summary{display:block;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.fb-detail-bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:8px 0;background:var(--dsw-alias-bg-layer-2);border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.fb-detail-identity{display:flex;flex-direction:column;min-width:0;flex:1}
.fb-detail-actions{display:flex;align-items:center;gap:6px}
.fb-panel{display:flex;flex-direction:column;gap:10px;padding-top:4px}
/* Author display wins over the UA sheet's [hidden], so state it explicitly. */
.fb-panel[hidden]{display:none}
.fb-group{display:flex;flex-direction:column;gap:6px}
.fb-group-title{margin:6px 0 0;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.fb-items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.fb-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill)}
.fb-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.fb-item-title{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fb-item-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.fb-form{display:flex;flex-direction:column;gap:12px}
.fb-form-inline{max-width:440px}
.fb-field{display:flex;flex-direction:column;gap:6px}
.fb-field>span{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.fb-select{height:36px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px}
.fb-select:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.fb-form-actions{display:flex;justify-content:flex-end;gap:8px}
.fb-btn-danger{color:var(--dsw-alias-state-error-primary)}
.fb-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
`
