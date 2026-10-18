export const STYLES = `
.fb-section,.fb-section *{box-sizing:border-box}
.fb-section{max-width:1040px;color:var(--dsw-alias-label-primary)}
.fb-section h2{margin:0 0 6px;font-size:20px}
.fb-section .fb-hint{margin:0 0 18px;color:var(--dsw-alias-label-secondary);line-height:1.55;font-size:13px}
.fb-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.fb-spacer{flex:1}
.fb-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:7px 12px;cursor:pointer;white-space:nowrap}
.fb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.fb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fb-btn:disabled{opacity:.5;cursor:default}
.fb-btn[data-primary=true]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;font-weight:600}
.fb-btn[data-danger=true]{color:var(--dsw-alias-state-error-primary)}
.fb-table-wrap{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:auto;background:var(--dsw-alias-bg-layer-3)}
.fb-table{width:100%;border-collapse:collapse;font-size:13px;min-width:0}
.fb-table th,.fb-table td{text-align:left;padding:8px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:middle}
.fb-table th{font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap}
.fb-table tbody tr:last-child td{border-bottom:0}
.fb-table tbody tr{cursor:pointer}
.fb-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fb-table tbody tr[data-selected=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.fb-name{font-weight:600;display:block}
.fb-sub{display:block;color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:2px;word-break:break-all;line-height:1.35}
.fb-actions{display:flex;gap:4px;flex-wrap:nowrap}
.fb-table .fb-btn{padding:5px 8px;font-size:12px}
.fb-empty{padding:22px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.fb-error{margin:0 0 12px;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:13px;white-space:pre-wrap}
.fb-ok{margin:0 0 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:13px}
.fb-detail{margin-top:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);padding:16px}
.fb-detail-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.fb-detail-head h3{margin:0;font-size:16px}
.fb-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
@media(max-width:820px){.fb-columns{grid-template-columns:minmax(0,1fr)}}
.fb-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px}
.fb-card h4{margin:0 0 8px;font-size:13px;color:var(--dsw-alias-label-secondary);font-weight:600}
.fb-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;max-height:420px;overflow:auto}
.fb-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3)}
.fb-item-main{min-width:0;flex:1}
.fb-item-name{display:block;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fb-item-meta{display:block;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.fb-tag{display:inline-block;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:6px}
.fb-modal-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:18px}
.fb-modal{width:min(560px,100%);max-height:90vh;overflow:auto;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.28)}
.fb-modal h3{margin:0 0 4px;font-size:17px}
.fb-modal .fb-hint{margin-bottom:14px}
.fb-form{display:flex;flex-direction:column;gap:12px}
.fb-field{display:flex;flex-direction:column;gap:5px}
.fb-field>span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.fb-field input,.fb-field select{width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.fb-field input:focus,.fb-field select:focus{border-color:var(--dsw-alias-brand-primary)}
.fb-radio{display:flex;gap:14px;font-size:13px}
.fb-radio label{display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}
.fb-radio input[type=radio]{width:auto;padding:0;margin:0;accent-color:var(--dsw-alias-brand-primary)}
.fb-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
.fb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
`
