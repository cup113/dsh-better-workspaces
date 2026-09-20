window.__ModuleLoader__.load({
	id: "dsh-better-workspaces",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom_client = require("react-dom/client");

		const { useState, useEffect, useLayoutEffect, useRef, useCallback, useSyncExternalStore } = react;
		const h = react.createElement;
		const NS = "better-workspaces";
		const API_BASE = "/better-workspaces/api";

		/* ================================================================ */
		/* util                                                              */
		/* ================================================================ */

		function cx() {
			let out = "";
			for (let i = 0; i < arguments.length; i += 1) {
				const part = arguments[i];
				if (part) out += (out === "" ? "" : " ") + part;
			}
			return out;
		}

		function qs(params) {
			const u = new URLSearchParams();
			for (const key of Object.keys(params)) {
				const value = params[key];
				if (value !== undefined && value !== null && value !== "" && value !== false) u.set(key, String(value));
			}
			const s = u.toString();
			return s === "" ? "" : "?" + s;
		}

		async function apiGet(path, signal) {
			const res = await fetch(API_BASE + path, {
				headers: { Accept: "application/json" },
				...(signal ? { signal } : {}),
			});
			return await res.json();
		}

		async function apiPost(path, body, signal) {
			const res = await fetch(API_BASE + path, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify(body ?? {}),
				...(signal ? { signal } : {}),
			});
			return await res.json();
		}

		function createRequestOwner() {
			let epoch = 0;
			const active = new Set();
			function abortAll() {
				epoch += 1;
				for (const token of active) token.controller.abort();
				active.clear();
			}
			return {
				begin(channel) {
					if (channel) {
						for (const prior of active) {
							if (prior.channel === channel) {
								prior.controller.abort();
								active.delete(prior);
							}
						}
					}
					const token = { epoch, channel: channel || null, controller: new AbortController() };
					active.add(token);
					return token;
				},
				owns(token) {
					return Boolean(token && token.epoch === epoch && active.has(token) && !token.controller.signal.aborted);
				},
				end(token) { active.delete(token); },
				abort(token) {
					if (!token) return;
					token.controller.abort();
					active.delete(token);
				},
				reset: abortAll,
			};
		}

		function ownershipError() {
			const error = new Error("request owner changed");
			error.name = "AbortError";
			error.code = "ABORT_ERR";
			return error;
		}

		function requireOwnership(owner, token) {
			if (!owner.owns(token)) throw ownershipError();
		}

		function fmtNum(n) {
			if (typeof n !== "number" || Number.isNaN(n)) return "0";
			if (n >= 100000) return Math.round(n / 1000) + "k";
			return String(n);
		}

		function createStore(initial) {
			let state = initial;
			const listeners = new Set();
			return {
				get: () => state,
				set: (next) => {
					state = typeof next === "function" ? next(state) : next;
					for (const listener of listeners) {
						try { listener(); } catch { /* listener faults are isolated */ }
					}
				},
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
		}

		function useStore(store, selector) {
			const state = useSyncExternalStore(store.subscribe, store.get, store.get);
			return selector(state);
		}

		function fmtRelTime(ts, lang) {
			if (!ts) return "";
			const diff = Date.now() - ts;
			try {
				const rtf = new Intl.RelativeTimeFormat(lang === "en" ? "en" : "zh", { numeric: "auto" });
				const mins = Math.round(diff / 60000);
				if (Math.abs(mins) < 60) return rtf.format(-mins, "minute");
				const hours = Math.round(mins / 60);
				if (Math.abs(hours) < 24) return rtf.format(-hours, "hour");
				return rtf.format(-Math.round(hours / 24), "day");
			} catch {
				return new Date(ts).toLocaleString();
			}
		}

		/* ================================================================ */
		/* css                                                               */
		/* ================================================================ */

		const CSS = `
body { --dsh-bw-green: var(--dsw-alias-state-success-primary, #1a7f37); --dsh-bw-red: var(--dsw-alias-state-error-primary, #cf222e); --dsh-bw-yellow: var(--dsw-alias-state-warn-primary, #9a6700); --dsh-bw-purple: #7347af; --dsh-bw-border: var(--dsw-alias-border-l3, rgba(128,128,128,.25)); --dsh-bw-hover: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); --dsh-bw-tertiary: var(--dsw-alias-label-tertiary, #8b949e); --dsh-bw-secondary: var(--dsw-alias-label-secondary, #59636e); --dsh-bw-primary-label: var(--dsw-alias-label-primary, #1f2328); --dsh-bw-accent: var(--dsw-alias-state-business-primary, #2f6feb); --dsh-bw-bg: var(--dsw-alias-bg-base, #fff); --dsh-bw-code: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
body[data-ds-dark-theme] { --dsh-bw-purple: #c9a4f0; }
.dsh-bw-green { color: var(--dsh-bw-green); }
.dsh-bw-red { color: var(--dsh-bw-red); }
.dsh-bw-yellow { color: var(--dsh-bw-yellow); }
.dsh-bw-purple { color: var(--dsh-bw-purple); }

/* ---- sidebar rows: stretch + badge row ---- */
[class*="_sessionRow"] { height: auto !important; min-height: 32px; flex-wrap: wrap; align-content: center; row-gap: 0; }
.dsh-bw-badges { flex-basis: 100%; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 0 8px 3px 26px; font-size: 11px; line-height: 16px; color: var(--dsh-bw-tertiary); pointer-events: none; overflow: hidden; }
.dsh-bw-badge { display: inline-flex; align-items: center; gap: 3px; min-width: 0; white-space: nowrap; }
.dsh-bw-badge-branch { max-width: 45%; overflow: hidden; text-overflow: ellipsis; }
.dsh-bw-badge-diff { font-variant-numeric: tabular-nums; }
.dsh-bw-ring { flex: none; }

/* ---- hero control ---- */
.dsh-bw-hero { display: inline-flex; align-items: center; gap: 2px; min-width: 0; position: relative; }
.dsh-bw-hero-btn { max-width: 240px; min-height: 28px; color: var(--dsh-bw-primary-label); cursor: pointer; background: 0 0; border: none; border-radius: 16px; align-items: center; gap: 4px; padding: 0 8px; font-size: 13px; font-weight: 500; line-height: 20px; display: inline-flex; }
.dsh-bw-hero-btn:hover:not(:disabled), .dsh-bw-hero-btn[aria-expanded="true"] { background: var(--dsh-bw-hover); }
.dsh-bw-hero-btn:disabled { cursor: default; opacity: .6; }
.dsh-bw-hero-label { text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }
.dsh-bw-hero-chevron { color: var(--dsw-alias-label-caption, #999); flex: none; }
.dsh-bw-hero-error { color: var(--dsh-bw-red); font-size: 12px; line-height: 18px; max-width: 320px; overflow-wrap: anywhere; padding: 0 8px; }
.dsh-bw-hero-panel-row { display: flex; align-items: center; gap: 6px; padding: 8px 10px; }
.dsh-bw-hero-input { border: .5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.4)); background: 0 0; color: var(--dsh-bw-primary-label); border-radius: 6px; outline: none; padding: 2px 8px; font-size: 12px; line-height: 20px; min-width: 140px; }

/* ---- popover ---- */
.dsh-bw-pop { position: relative; display: inline-flex; }
.dsh-bw-pop-panel { position: absolute; top: calc(100% + 4px); left: 0; z-index: 60; min-width: 180px; max-width: 340px; background: var(--dsw-alias-bg-overlay, var(--dsh-bw-bg)); border: 1px solid var(--dsh-bw-border); border-radius: 10px; box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.18)); padding: 4px; color: var(--dsh-bw-primary-label); font-size: 12px; }
.dsh-bw-pop-right { left: auto; right: 0; }
.dsh-bw-menu { display: flex; flex-direction: column; max-height: 320px; overflow-y: auto; }
.dsh-bw-menu-item { display: flex; align-items: baseline; gap: 6px; width: 100%; text-align: left; background: 0 0; border: none; border-radius: 6px; padding: 5px 8px; cursor: pointer; color: var(--dsh-bw-primary-label); font-size: 12px; line-height: 18px; }
.dsh-bw-menu-item:hover:not(:disabled) { background: var(--dsh-bw-hover); }
.dsh-bw-menu-item:disabled { cursor: default; opacity: .55; }
.dsh-bw-menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bw-menu-hint { flex: none; color: var(--dsh-bw-tertiary); font-size: 11px; }
.dsh-bw-menu-reason { flex: none; color: var(--dsh-bw-tertiary); font-size: 11px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bw-menu-sep { height: 1px; background: var(--dsh-bw-border); margin: 4px 6px; }
.dsh-bw-menu-item-active .dsh-bw-menu-label { color: var(--dsh-bw-accent); font-weight: 500; }

/* ---- dock pill ---- */
.dsh-bw-pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; margin: 2px 0; border-radius: 12px; border: 1px solid var(--dsh-bw-border); background: 0 0; color: var(--dsh-bw-secondary); cursor: pointer; font-size: 12px; line-height: 1; font-variant-numeric: tabular-nums; align-self: center; flex: 0 0 auto; width: fit-content; max-width: 100%; white-space: nowrap; }
.dsh-bw-pill > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dsh-bw-pill:hover { background: var(--dsh-bw-hover); color: var(--dsh-bw-primary-label); }
.dsh-bw-pill-icon { color: var(--dsh-bw-tertiary); }

/* ---- shared view chrome ---- */
.dsh-bw-view { display: flex; flex-direction: column; flex: 1; min-height: 0; height: 100%; overflow: hidden; font-size: 13px; color: var(--dsh-bw-primary-label); background: var(--dsh-bw-bg); }
.dsh-bw-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--dsh-bw-border); flex-wrap: wrap; flex: none; }
.dsh-bw-toolbar-spacer { flex: 1; }
.dsh-bw-seg { display: inline-flex; border: 1px solid var(--dsh-bw-border); border-radius: 8px; overflow: hidden; }
.dsh-bw-seg button { background: 0 0; border: none; padding: 3px 10px; font-size: 12px; cursor: pointer; color: var(--dsh-bw-secondary); }
.dsh-bw-seg button[aria-pressed="true"] { background: var(--dsh-bw-hover); color: var(--dsh-bw-primary-label); font-weight: 500; }
.dsh-bw-btn { height: 26px; padding: 0 12px; border-radius: 13px; border: 1px solid var(--dsh-bw-border); background: 0 0; cursor: pointer; font-size: 12px; color: var(--dsh-bw-primary-label); display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.dsh-bw-btn:hover:not(:disabled) { background: var(--dsh-bw-hover); }
.dsh-bw-btn:disabled { opacity: .45; cursor: default; }
.dsh-bw-btn-primary { background: var(--dsh-bw-accent); border-color: transparent; color: #fff; }
.dsh-bw-btn-primary:hover:not(:disabled) { background: var(--dsh-bw-accent); filter: brightness(1.08); }
.dsh-bw-btn-danger { color: var(--dsh-bw-red); }
.dsh-bw-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--dsh-bw-secondary); cursor: pointer; user-select: none; }
.dsh-bw-banner { margin: 8px 16px 0; padding: 6px 10px; font-size: 12px; border-radius: 8px; flex: none; overflow-wrap: anywhere; }
.dsh-bw-banner-ok { background: color-mix(in srgb, var(--dsh-bw-green) 12%, transparent); color: var(--dsh-bw-green); }
.dsh-bw-banner-err { background: color-mix(in srgb, var(--dsh-bw-red) 12%, transparent); color: var(--dsh-bw-red); }
.dsh-bw-pr { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 420px; font-size: 12px; }
.dsh-bw-pr-num { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-bw-pr-title { color: var(--dsh-bw-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dsh-bw-pr a { color: var(--dsh-bw-accent); text-decoration: none; flex: none; }
.dsh-bw-branch { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--dsh-bw-secondary); min-width: 0; }
.dsh-bw-branch-name { font-family: var(--dsh-bw-code); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.dsh-bw-sync { font-size: 12px; color: var(--dsh-bw-tertiary); font-variant-numeric: tabular-nums; flex: none; }

/* ---- diff body split ---- */
.dsh-bw-body { flex: 1; min-height: 0; display: flex; }
.dsh-bw-filelist { width: 320px; max-width: 40%; flex: none; border-right: 1px solid var(--dsh-bw-border); overflow-y: auto; }
.dsh-bw-fileitem { width: 100%; border: 0; background: transparent; color: inherit; text-align: left; padding: 4px 10px; cursor: pointer; display: flex; gap: 6px; align-items: baseline; font: inherit; font-size: 12px; }
.dsh-bw-fileitem:hover { background: var(--dsh-bw-hover); }
.dsh-bw-fileitem-active { background: var(--dsh-bw-hover); }
.dsh-bw-fileitem-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bw-fileitem-stat { flex: none; font-variant-numeric: tabular-nums; font-size: 11px; }
.dsh-bw-editor { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.dsh-bw-editor-bar { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--dsh-bw-border); flex: none; }
.dsh-bw-editor-path { font-size: 12px; color: var(--dsh-bw-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dsh-bw-editor-dirty { color: var(--dsh-bw-accent); font-size: 11px; flex: none; }
.dsh-bw-editor-area { flex: 1; min-height: 0; resize: none; border: none; outline: none; padding: 10px 12px; font-family: var(--dsh-bw-code); font-size: 12px; line-height: 1.55; color: var(--dsh-bw-primary-label); background: var(--dsh-bw-bg); tab-size: 4; white-space: pre; overflow: auto; }
.dsh-bw-fileedit { flex: none; margin-left: 8px; }
[data-bw-wt] > svg { display: none; }
.dsh-bw-wt-icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; }
.dsh-bw-wt-icon svg { width: 15px; height: 15px; }
.dsh-bw-statusletter { flex: none; width: 14px; text-align: center; font-family: var(--dsh-bw-code); font-weight: 600; }
.dsh-bw-diffpane { flex: 1; min-width: 0; overflow: auto; }
.dsh-bw-empty { padding: 32px; text-align: center; color: var(--dsh-bw-tertiary); font-size: 13px; }
.dsh-bw-file { border-bottom: 1px solid var(--dsh-bw-border); }
.dsh-bw-filehead { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; background: var(--dsh-bw-bg); border-bottom: 1px solid var(--dsh-bw-border); font-size: 12px; }
.dsh-bw-filetoggle { min-width: 0; flex: 1; display: flex; align-items: center; gap: 8px; border: 0; padding: 6px 12px; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
.dsh-bw-filetoggle:hover { background: var(--dsh-bw-hover); }
.dsh-bw-caret { flex: none; color: var(--dsh-bw-tertiary); width: 12px; }
.dsh-bw-filepath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dsh-bw-code); font-weight: 500; }
.dsh-bw-filestat { flex: none; font-variant-numeric: tabular-nums; }
.dsh-bw-notice { padding: 12px; color: var(--dsh-bw-tertiary); font-size: 12px; }
.dsh-bw-hunkhdr { padding: 2px 12px 2px 100px; background: color-mix(in srgb, var(--dsh-bw-accent) 6%, transparent); color: var(--dsh-bw-tertiary); font-family: var(--dsh-bw-code); font-size: 11px; line-height: 18px; white-space: pre; overflow: hidden; }
.dsh-bw-line { display: flex; font-family: var(--dsh-bw-code); font-size: 12px; line-height: 18px; }
.dsh-bw-ln { flex: none; width: 44px; text-align: right; padding-right: 8px; color: var(--dsw-alias-label-caption, #999); user-select: none; font-size: 11px; line-height: 18px; }
.dsh-bw-code { flex: 1; min-width: 0; white-space: pre; padding-right: 12px; }
.dsh-bw-wrap .dsh-bw-code { white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-bw-line-add { background: color-mix(in srgb, var(--dsh-bw-green) 13%, transparent); }
.dsh-bw-line-del { background: color-mix(in srgb, var(--dsh-bw-red) 13%, transparent); }
.dsh-bw-line-meta { color: var(--dsh-bw-tertiary); font-style: italic; }
.dsh-bw-commitrow { display: flex; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--dsh-bw-border); align-items: center; flex: none; }
.dsh-bw-commit-input { flex: 1; min-width: 0; border: 1px solid var(--dsh-bw-border); background: 0 0; color: var(--dsh-bw-primary-label); border-radius: 8px; outline: none; padding: 4px 10px; font-size: 12px; line-height: 18px; }
.dsh-bw-commit-input:focus { border-color: var(--dsh-bw-accent); }
.dsh-bw-commits { overflow-y: auto; border-bottom: 1px solid var(--dsh-bw-border); max-height: 220px; flex: none; }
.dsh-bw-commit { width: 100%; border: 0; background: transparent; color: inherit; text-align: left; padding: 5px 12px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; font: inherit; font-size: 12px; }
.dsh-bw-commit:hover { background: var(--dsh-bw-hover); }
.dsh-bw-commit-active { background: var(--dsh-bw-hover); }
.dsh-bw-sha { font-family: var(--dsh-bw-code); color: var(--dsh-bw-accent); flex: none; }
.dsh-bw-commit-subject { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bw-commit-meta { flex: none; color: var(--dsh-bw-tertiary); font-size: 11px; }
.dsh-bw-unpushed-dot { flex: none; color: var(--dsh-bw-green); font-size: 11px; }
.dsh-bw-form { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; min-width: 260px; }
.dsh-bw-form label { font-size: 12px; color: var(--dsh-bw-secondary); display: flex; flex-direction: column; gap: 3px; }
.dsh-bw-form input[type="text"], .dsh-bw-form textarea { border: 1px solid var(--dsh-bw-border); background: 0 0; color: var(--dsh-bw-primary-label); border-radius: 6px; outline: none; padding: 4px 8px; font-size: 12px; font-family: inherit; }
.dsh-bw-form textarea { min-height: 80px; resize: vertical; }
.dsh-bw-form-actions { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }

/* ---- composer forge control (issue / pull request reference) ---- */
.dsh-bw-forge { display: inline-flex; align-items: center; }
.dsh-bw-forge-btn { position: relative; width: 28px; height: 28px; flex: none; display: grid; place-items: center; border: none; border-radius: 999px; background: 0 0; color: var(--dsh-bw-primary-label); cursor: pointer; padding: 0; }
.dsh-bw-forge-btn:hover:not(:disabled) { background: var(--dsh-bw-hover); }
.dsh-bw-forge-btn:disabled { opacity: .5; cursor: default; }
.dsh-bw-forge-btn[data-armed="true"] { color: var(--dsh-bw-accent); }
.dsh-bw-forge-count { position: absolute; top: -1px; right: -1px; min-width: 13px; height: 13px; padding: 0 3px; border-radius: 7px; background: var(--dsh-bw-accent); color: #fff; font-size: 9px; font-weight: 600; line-height: 13px; text-align: center; font-variant-numeric: tabular-nums; }
/* The picker is a fixed dialog, not an anchored popover: the composer row's
   overflow would clip a panel that grows upward, and the list needs room. */
.dsh-bw-forge-overlay { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,.28); display: flex; align-items: center; justify-content: center; padding: 24px; }
.dsh-bw-forge-dialog { width: min(560px, 100%); max-height: min(70vh, 560px); display: flex; flex-direction: column; background: var(--dsw-alias-bg-overlay, var(--dsh-bw-bg)); border: 1px solid var(--dsh-bw-border); border-radius: 12px; box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.18)); color: var(--dsh-bw-primary-label); overflow: hidden; }
.dsh-bw-forge-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsh-bw-border); flex: none; }
.dsh-bw-forge-titlebar { flex: none; font-size: 13px; font-weight: 600; }
.dsh-bw-forge-search { flex: 1; min-width: 0; border: 1px solid var(--dsh-bw-border); background: 0 0; color: var(--dsh-bw-primary-label); border-radius: 8px; outline: none; padding: 5px 10px; font-size: 13px; font-family: inherit; line-height: 20px; }
.dsh-bw-forge-search:focus { border-color: var(--dsh-bw-accent); }
.dsh-bw-forge-close { flex: none; width: 26px; height: 26px; border: none; border-radius: 8px; background: 0 0; color: var(--dsh-bw-secondary); cursor: pointer; font-size: 15px; line-height: 1; }
.dsh-bw-forge-close:hover { background: var(--dsh-bw-hover); }
.dsh-bw-forge-list { overflow-y: auto; padding: 4px; flex: 1; min-height: 0; }
.dsh-bw-forge-row { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; background: 0 0; border: none; border-radius: 8px; padding: 7px 9px; cursor: pointer; color: var(--dsh-bw-primary-label); font-size: 13px; line-height: 19px; }
.dsh-bw-forge-row:hover { background: var(--dsh-bw-hover); }
.dsh-bw-forge-row[data-attached="true"] { background: color-mix(in srgb, var(--dsh-bw-accent) 10%, transparent); }
button[class*="dsh-bw-"]:focus-visible, input[class*="dsh-bw-"]:focus-visible, textarea[class*="dsh-bw-"]:focus-visible { outline: 2px solid var(--dsh-bw-accent); outline-offset: 2px; }
.dsh-bw-forge-num { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-bw-forge-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bw-forge-meta { flex: none; color: var(--dsh-bw-tertiary); font-size: 11px; }
.dsh-bw-forge-icon { flex: none; color: var(--dsh-bw-tertiary); }
.dsh-bw-forge-empty { padding: 24px 16px; text-align: center; color: var(--dsh-bw-tertiary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.dsh-bw-forge-hint { padding: 6px 12px 10px; color: var(--dsh-bw-tertiary); font-size: 11px; line-height: 16px; flex: none; }

/* ---- right-sidebar diff tab ---- */
/* The panel is as narrow as 300px: stack the file list over the diff pane
   instead of the conversation view's side-by-side split. */
.dsh-bw-sb { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.dsh-bw-sb .dsh-bw-toolbar { padding-left: 12px; padding-right: 12px; }
.dsh-bw-sb .dsh-bw-commitrow { padding-left: 12px; padding-right: 12px; }
.dsh-bw-sb .dsh-bw-body { flex-direction: column; }
.dsh-bw-sb .dsh-bw-filelist { width: auto; max-width: none; max-height: 32%; border-right: none; border-bottom: 1px solid var(--dsh-bw-border); }
.dsh-bw-tabicon { display: inline-flex; width: 16px; height: 16px; flex: none; align-items: center; justify-content: center; }
`;

		const CSS_TAG = "dsh-better-workspaces/client.css";
		const CSS_STATE = Symbol.for("dsh-better-workspaces/client.css-state");
		function mountCss() {
			if (typeof document === "undefined") return () => {};
			let state = window[CSS_STATE];
			if (!state || !state.tag) {
				let tag = document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]');
				if (!tag) {
					tag = document.createElement("style");
					tag.dataset.plugin = "dsh-better-workspaces";
					tag.dataset.pluginCss = CSS_TAG;
					document.head.appendChild(tag);
				}
				tag.textContent = CSS;
				state = { tag, refs: 0 };
				window[CSS_STATE] = state;
			}
			state.tag.textContent = CSS;
			state.refs += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				state.refs -= 1;
				if (state.refs > 0) return;
				if (state.tag.parentNode) state.tag.parentNode.removeChild(state.tag);
				if (window[CSS_STATE] === state) delete window[CSS_STATE];
			};
		}

		/* ================================================================ */
		/* locale dictionaries                                               */
		/* ================================================================ */

		const zh = {
			"view.diff": "diff",
			"guide.title": "代码变更",
			"guide.description": "查看本会话的代码变更，并提交 / 推送 / 建 PR",
			"hero.modeLocal": "本地",
			"hero.modeWorktree": "新建 worktree",
			"hero.pickBase": "基于:{branch}",
			"hero.pickExplicit": "新分支:{name}",
			"hero.stageHint": "选定基分支即创建并跳转，草稿随迁",
			"hero.stageCreateFallback": "立即创建",
			"hero.blockReason": "正在创建隔离 Worktree…",
			"hero.localSuffix": "（本地）",
			"files.save": "保存",
			"files.saving": "保存中…",
			"files.cancelEdit": "取消",
			"files.conflict": "文件在磁盘上已被修改",
			"files.reload": "重新加载",
			"files.editUnavailable": "该文件不可编辑",
			"files.saveFailed": "保存失败",
			"diff.editFile": "编辑",
			"diff.modeSession": "本会话",
			"diff.modeTask": "任务",
			"diff.sessionEmpty": "该会话尚未通过写文件工具修改文件",
			"diff.sessionUnavailable": "无法读取该会话的历史记录",
			"diff.taskUnavailable": "任务 diff 不可用：元数据缺少基 ref（需重启 dsh 以启用宿主新路由）",
			"hero.newBranchItem": "＋ 新建分支…",
			"hero.newBranchPlaceholder": "新分支名",
			"hero.create": "创建",
			"hero.creating": "创建中…",
			"hero.switching": "切换中…",
			"hero.checkingOut": "检出 PR 中…",
			"hero.failed": "失败:{message}",
			"hero.baseHint": "基于 {branch}",
			"hero.current": "当前",
			"hero.default": "默认",
			"forge.addIssuePr": "添加 issue 或 PR",
			"forge.pickerTitle": "添加 issue 或 PR",
			"forge.searchPlaceholder": "在已取回的列表里筛选编号或标题",
			"forge.empty": "这个仓库没有未关闭的 issue 或 PR",
			"forge.noResults": "没有匹配的 issue 或 PR",
			"forge.loadFailed": "无法读取列表",
			"forge.detailFailed": "无法读取该 issue/PR 的内容",
			"forge.close": "关闭",
			"forge.fork": "fork",
			"forge.attachFailed": "无法把引用插入输入框：{reason}",
			"forge.attachFailedNoTarget": "输入框当前不可写入（正在提交或不可编辑）",
			"forge.attachFailedRejected": "引用插入坐标无效或草稿已变化，请重试",
			"forge.restorePending": "引用尚未安全恢复，请等待片刻后重试发送",
			"forge.invalid": "损坏的 Forge 引用（可删除）",
			"forge.hint": "选中即挂上引用；发送时展开为标题 / 链接 / 基线 / 正文，草稿里只留一个引用片",
			"forge.auth.cli_missing": "未找到 gh CLI：请先安装 GitHub CLI",
			"forge.auth.unauthenticated": "gh 未登录：请先执行 gh auth login",
			"forge.auth.no_remote": "该仓库没有可用的 GitHub 远端",
			"forge.auth.error": "gh 调用失败，请检查网络或权限",
			"forge.pullsFailed": "PR 列表不可用:{message}",
			"pill.title": "在右侧栏查看代码变更",
			"pill.dirty": "{n} 个文件有改动",
			"diff.modeUncommitted": "未提交",
			"diff.modeBase": "对比基线",
			"diff.paneFiles": "文件",
			"diff.paneCommits": "提交",
			"diff.empty": "没有变更",
			"diff.binary": "二进制",
			"diff.binaryBody": "二进制文件,不显示内容",
			"diff.tooLarge": "过大",
			"diff.tooLargeBody": "该文件差异过大,已省略",
			"diff.truncated": "差异总量过大,部分文件已省略",
			"diff.refresh": "刷新",
			"diff.ignoreWs": "忽略空白",
			"diff.wrap": "自动换行",
			"diff.commitPlaceholder": "提交信息(暂存全部并提交)",
			"diff.commitAll": "提交全部",
			"diff.backToBranch": "← 返回分支 diff",
			"diff.unpushed": "未推送",
			"diff.prMergeable": "可合并",
			"diff.prConflicting": "有冲突",
			"diff.prDraft": "草稿",
			"diff.openPr": "打开",
			"diff.merge": "合并 PR",
			"diff.mergeMethod": "合并方式",
			"diff.method.squash": "squash",
			"diff.method.merge": "merge",
			"diff.method.rebase": "rebase",
			"diff.autoMerge": "自动合并",
			"diff.mergeRun": "执行合并",
			"diff.createPrTitle": "标题",
			"diff.createPrBody": "描述",
			"diff.createPrDraft": "以草稿创建",
			"diff.createPrRun": "创建 PR",
			"diff.commitListEmpty": "基线之上没有提交",
			"diff.loading": "加载中…",
			"diff.notGit": "此工作区不是 git 仓库",
			"diff.checks": "检查:{status}({completed}/{total})",
			"checks.success": "通过",
			"checks.pending": "进行中",
			"checks.failure": "失败",
			"checks.none": "无",
			"actions.commit": "提交",
			"actions.pull": "拉取",
			"actions.push": "推送",
			"actions.fetch": "抓取远端",
			"actions.discard": "丢弃改动",
			"actions.mergeToBase": "合并到基线",
			"actions.updateFromBase": "从基线更新",
			"actions.createPr": "创建 PR",
			"actions.mergePr": "合并 PR",
			"actions.autoMergeOff": "关闭自动合并",
			"actions.archive": "归档 worktree",
			"actions.more": "更多",
			"actions.commit.done": "已提交",
			"actions.pull.done": "已拉取",
			"actions.push.done": "已推送",
			"actions.fetch.done": "已抓取远端",
			"actions.discard.done": "已丢弃改动",
			"actions.mergeToBase.done": "已合并到基线",
			"actions.updateFromBase.done": "已从基线更新",
			"actions.createPr.done": "PR 已创建",
			"actions.mergePr.done": "PR 已合并",
			"actions.autoMergeOff.done": "已关闭自动合并",
			"actions.archive.done": "worktree 已归档",
			"actions.failed": "操作失败",
			"actions.disabled.agentRunning": "Agent 正在运行",
			"actions.commit.clean": "无未提交改动",
			"actions.commit.noMessage": "请填写提交信息",
			"actions.pull.noRemote": "无远端",
			"actions.pull.upToDate": "已是最新",
			"actions.push.noRemote": "无远端",
			"actions.push.noBranch": "无分支(detached HEAD)",
			"actions.push.nothing": "无未推送提交",
			"actions.push.prCheckout": "PR 检出分支没有经验证的安全上游",
			"actions.mergePr.noPr": "没有打开的 PR",
			"actions.mergePr.notOpen": "PR 未打开",
			"actions.mergePr.draft": "草稿 PR 不可合并",
			"actions.mergePr.conflicting": "PR 有冲突",
			"actions.merge.detached": "detached HEAD,无法合并",
			"actions.merge.dirtyCurrent": "有未提交改动,先提交或丢弃",
			"actions.merge.dirtyOwner": "基线分支工作区有未提交改动",
			"actions.merge.conflict": "合并冲突",
			"actions.merge.recoveryCwd": "请在此工作区解决或中止：{cwd}",
			"actions.mergeToBase.onBase": "当前就在基线分支",
			"actions.mergeToBase.noOwner": "基线分支未在任何 worktree 检出",
			"actions.mergeToBase.nothing": "无领先基线的提交",
			"actions.updateFromBase.noBase": "无法解析基线分支",
			"actions.updateFromBase.upToDate": "已包含基线全部提交",
			"actions.pr.notGithub": "远端不是 GitHub 或无法解析",
			"actions.pr.checkout": "PR 检出分支不能用于创建第二个 PR",
			"actions.archive.notManaged": "仅托管 worktree 可归档",
			"actions.discard.confirm": "确定丢弃全部未提交改动?不可恢复。",
			"actions.discard.unsafePath": "路径不安全",
			"actions.archive.confirm": "确定归档(删除)该 worktree 目录?",
			"actions.archive.draftBlocked": "工作区中仍有未发送草稿、附件或正在提交的会话，无法归档",
			"actions.archive.unsafeConfirm": "{message}。仍然强制归档?",
			"actions.unknown": "未知操作:{name}",
		};

		const en = {
			"view.diff": "diff",
			"guide.title": "Changes",
			"guide.description": "Review this session's changes - commit, push, or open a PR",
			"hero.modeLocal": "Local",
			"hero.modeWorktree": "New worktree",
			"hero.pickBase": "Base: {branch}",
			"hero.pickExplicit": "New: {name}",
			"hero.stageHint": "picking a base creates and jumps, carrying your draft",
			"hero.stageCreateFallback": "Create now",
			"hero.blockReason": "Creating isolated Worktree…",
			"hero.localSuffix": " (local)",
			"files.save": "Save",
			"files.saving": "Saving…",
			"files.cancelEdit": "Cancel",
			"files.conflict": "File changed on disk since load",
			"files.reload": "Reload",
			"files.editUnavailable": "This file cannot be edited",
			"files.saveFailed": "Save failed",
			"diff.editFile": "Edit",
			"diff.modeSession": "This session",
			"diff.modeTask": "Task",
			"diff.sessionEmpty": "This session has not written any files yet",
			"diff.sessionUnavailable": "This session's history cannot be paged",
			"diff.taskUnavailable": "Task diff unavailable: metadata lacks a base ref (restart dsh to enable the host route)",
			"hero.newBranchItem": "＋ New branch…",
			"hero.newBranchPlaceholder": "New branch name",
			"hero.create": "Create",
			"hero.creating": "Creating…",
			"hero.switching": "Switching…",
			"hero.checkingOut": "Checking out PR…",
			"hero.failed": "Failed: {message}",
			"hero.baseHint": "from {branch}",
			"hero.current": "current",
			"hero.default": "default",
			"forge.addIssuePr": "Add issue or PR",
			"forge.pickerTitle": "Add issue or PR",
			"forge.searchPlaceholder": "Filter the fetched page by number or title",
			"forge.empty": "No open issues or pull requests in this repository",
			"forge.noResults": "No matching issue or pull request",
			"forge.loadFailed": "Could not load the list",
			"forge.detailFailed": "Could not read that issue/pull request",
			"forge.close": "Close",
			"forge.fork": "fork",
			"forge.attachFailed": "Could not insert the reference: {reason}",
			"forge.attachFailedNoTarget": "the input is not writable right now (submitting or read-only)",
			"forge.attachFailedRejected": "the insertion span is invalid or the draft changed; please try again",
			"forge.restorePending": "a reference has not been safely restored yet; wait a moment and retry send",
			"forge.invalid": "Broken Forge reference (delete it to continue)",
			"forge.hint": "Picking attaches a reference; sending expands it to title / link / base / body — the draft keeps one chip",
			"forge.auth.cli_missing": "gh CLI not found — install GitHub CLI first",
			"forge.auth.unauthenticated": "gh is not signed in — run gh auth login",
			"forge.auth.no_remote": "This repository has no usable GitHub remote",
			"forge.auth.error": "gh call failed — check network or permissions",
			"forge.pullsFailed": "Pull request list unavailable: {message}",
			"pill.title": "View changes in the sidebar",
			"pill.dirty": "{n} files changed",
			"diff.modeUncommitted": "Uncommitted",
			"diff.modeBase": "vs base",
			"diff.paneFiles": "Files",
			"diff.paneCommits": "Commits",
			"diff.empty": "No changes",
			"diff.binary": "BIN",
			"diff.binaryBody": "Binary file — content hidden",
			"diff.tooLarge": "LARGE",
			"diff.tooLargeBody": "File diff too large — omitted",
			"diff.truncated": "Total diff too large — some files omitted",
			"diff.refresh": "Refresh",
			"diff.ignoreWs": "Ignore whitespace",
			"diff.wrap": "Wrap lines",
			"diff.commitPlaceholder": "Commit message (stage all & commit)",
			"diff.commitAll": "Commit all",
			"diff.backToBranch": "← Back to branch diff",
			"diff.unpushed": "unpushed",
			"diff.prMergeable": "mergeable",
			"diff.prConflicting": "conflicting",
			"diff.prDraft": "draft",
			"diff.openPr": "Open",
			"diff.merge": "Merge PR",
			"diff.mergeMethod": "Method",
			"diff.method.squash": "squash",
			"diff.method.merge": "merge",
			"diff.method.rebase": "rebase",
			"diff.autoMerge": "Auto-merge",
			"diff.mergeRun": "Merge",
			"diff.createPrTitle": "Title",
			"diff.createPrBody": "Description",
			"diff.createPrDraft": "Create as draft",
			"diff.createPrRun": "Create PR",
			"diff.commitListEmpty": "No commits above base",
			"diff.loading": "Loading…",
			"diff.notGit": "This workspace is not a git repository",
			"diff.checks": "Checks: {status} ({completed}/{total})",
			"checks.success": "passing",
			"checks.pending": "pending",
			"checks.failure": "failing",
			"checks.none": "none",
			"actions.commit": "Commit",
			"actions.pull": "Pull",
			"actions.push": "Push",
			"actions.fetch": "Fetch",
			"actions.discard": "Discard",
			"actions.mergeToBase": "Merge to base",
			"actions.updateFromBase": "Update from base",
			"actions.createPr": "Create PR",
			"actions.mergePr": "Merge PR",
			"actions.autoMergeOff": "Disable auto-merge",
			"actions.archive": "Archive worktree",
			"actions.more": "More",
			"actions.commit.done": "Committed",
			"actions.pull.done": "Pulled",
			"actions.push.done": "Pushed",
			"actions.fetch.done": "Fetched",
			"actions.discard.done": "Changes discarded",
			"actions.mergeToBase.done": "Merged into base",
			"actions.updateFromBase.done": "Updated from base",
			"actions.createPr.done": "PR created",
			"actions.mergePr.done": "PR merged",
			"actions.autoMergeOff.done": "Auto-merge disabled",
			"actions.archive.done": "Worktree archived",
			"actions.failed": "Action failed",
			"actions.disabled.agentRunning": "Agent is running",
			"actions.commit.clean": "Nothing to commit",
			"actions.commit.noMessage": "Enter a commit message",
			"actions.pull.noRemote": "No remote",
			"actions.pull.upToDate": "Up to date",
			"actions.push.noRemote": "No remote",
			"actions.push.noBranch": "No branch (detached HEAD)",
			"actions.push.nothing": "Nothing to push",
			"actions.push.prCheckout": "PR checkout has no verified safe upstream",
			"actions.mergePr.noPr": "No open PR",
			"actions.mergePr.notOpen": "PR is not open",
			"actions.mergePr.draft": "Draft PR cannot be merged",
			"actions.mergePr.conflicting": "PR has conflicts",
			"actions.merge.detached": "Detached HEAD — cannot merge",
			"actions.merge.dirtyCurrent": "Uncommitted changes — commit or discard first",
			"actions.merge.dirtyOwner": "Base branch working tree has uncommitted changes",
			"actions.merge.conflict": "Merge conflict",
			"actions.merge.recoveryCwd": "Resolve or abort in this workspace: {cwd}",
			"actions.mergeToBase.onBase": "Already on the base branch",
			"actions.mergeToBase.noOwner": "Base branch is not checked out in any worktree",
			"actions.mergeToBase.nothing": "No commits ahead of base",
			"actions.updateFromBase.noBase": "Cannot resolve the base branch",
			"actions.updateFromBase.upToDate": "Already contains every base commit",
			"actions.pr.notGithub": "Remote is not GitHub or unparsable",
			"actions.pr.checkout": "A PR checkout cannot create a second PR",
			"actions.archive.notManaged": "Only managed worktrees can be archived",
			"actions.discard.confirm": "Discard ALL uncommitted changes? This cannot be undone.",
			"actions.discard.unsafePath": "Unsafe path",
			"actions.archive.confirm": "Archive (delete) this worktree directory?",
			"actions.archive.draftBlocked": "A session in this workspace still has an unsent draft, attachment, or submission",
			"actions.archive.unsafeConfirm": "{message}. Force archive anyway?",
			"actions.unknown": "Unknown action: {name}",
		};

		/* ================================================================ */
		/* module singletons (set in apply)                                  */
		/* ================================================================ */

		let appCtx = null;
		let activeLifecycleEpoch = 0;
		let lifecycleEpochCounter = 0;
		let feed = null;
		let tt = (key) => key;

		function setTestRuntime(ctx, nextFeed = null, translate = (key) => key) {
			const previous = { appCtx, feed, tt };
			appCtx = ctx;
			feed = nextFeed;
			tt = translate;
			return () => {
				appCtx = previous.appCtx;
				feed = previous.feed;
				tt = previous.tt;
			};
		}

		function t(key, params) {
			const raw = tt(key, params);
			if (raw === key && params) {
				// extremely small fallback interpolation if locale service returned the key
				let out = key;
				for (const name of Object.keys(params)) out = out.replace("{" + name + "}", String(params[name]));
				return out;
			}
			return raw;
		}

		function lang() {
			try {
				const value = appCtx && appCtx.locale && appCtx.locale.current;
				if (typeof value === "string" && value.startsWith("en")) return "en";
				if (typeof value === "function") {
					const v = value();
					if (typeof v === "string" && v.startsWith("en")) return "en";
				}
			} catch { /* default zh */ }
			return "zh";
		}

		/* ================================================================ */
		/* git feed (SSE + polling snapshot store)                           */
		/* ================================================================ */

		function createGitFeed() {
			const store = createStore({ byCwd: {}, tracked: {} });
			const serialized = new Map();
			let es = null;
			let pollTimer = null;
			let disposed = false;
			let polling = false;
			const requests = new AbortController();

			function merge(snapshot) {
				if (disposed || !snapshot || typeof snapshot.cwd !== "string" || !store.get().tracked[snapshot.cwd]) return;
				const current = store.get().byCwd[snapshot.cwd];
				if (current && typeof current.at === "number" && typeof snapshot.at === "number" && current.at > snapshot.at) return;
				let key;
				try {
					key = JSON.stringify({ ...snapshot, at: 0 });
				} catch {
					key = String(snapshot.at);
				}
				if (serialized.get(snapshot.cwd) === key) return;
				serialized.set(snapshot.cwd, key);
				store.set((s) => ({ ...s, byCwd: { ...s.byCwd, [snapshot.cwd]: snapshot } }));
			}

			async function pollCwd(cwd) {
				try {
					const result = await apiPost("/snapshots", { cwds: [cwd] }, requests.signal);
					if (result && result.ok && result.byCwd && result.byCwd[cwd]) merge(result.byCwd[cwd]);
				} catch { /* transient or disposed */ }
			}

			async function pollAll() {
				if (polling || disposed) return;
				const cwds = Object.keys(store.get().tracked);
				if (cwds.length === 0) return;
				polling = true;
				try {
					const result = await apiPost("/snapshots", { cwds }, requests.signal);
					if (result && result.ok) for (const key of Object.keys(result.byCwd || {})) merge(result.byCwd[key]);
				} catch { /* transient or disposed */ }
				finally { polling = false; }
			}

			function connect() {
				try {
					es = new EventSource(API_BASE + "/events");
					es.addEventListener("snapshot", (event) => {
						try {
							merge(JSON.parse(event.data));
						} catch { /* malformed frame */ }
					});
				} catch {
					es = null; // polling covers
				}
			}

			connect();
			pollTimer = setInterval(pollAll, 15000);

			return {
				store,
				track(cwd) {
					if (!cwd) return;
					const count = store.get().tracked[cwd] || 0;
					store.set((s) => ({ ...s, tracked: { ...s.tracked, [cwd]: count + 1 } }));
					if (count === 0) pollCwd(cwd);
				},
				untrack(cwd) {
					if (!cwd) return;
					store.set((s) => {
						const count = s.tracked[cwd] || 0;
						if (count === 0) return s;
						const tracked = { ...s.tracked };
						if (count === 1) {
							delete tracked[cwd];
							serialized.delete(cwd);
							const byCwd = { ...s.byCwd };
							delete byCwd[cwd];
							return { ...s, tracked, byCwd };
						}
						tracked[cwd] = count - 1;
						return { ...s, tracked };
					});
				},
				refresh(cwd) {
					if (cwd) pollCwd(cwd);
					else pollAll();
				},
				dispose() {
					disposed = true;
					requests.abort();
					try { if (es) es.close(); } catch { /* ignore */ }
					if (pollTimer) clearInterval(pollTimer);
				},
			};
		}

		const detectCache = new Map();
		function setBoundedClientCache(map, key, value, max = 512) {
			map.delete(key);
			map.set(key, value);
			while (map.size > max) map.delete(map.keys().next().value);
		}
		async function detectPath(path, signal) {
			const hit = detectCache.get(path);
			if (hit && Date.now() - hit.at < 10000) return hit.value;
			let value;
			try {
				value = await apiGet("/detect" + qs({ path }), signal);
			} catch (error) {
				if (signal && signal.aborted) throw error;
				value = { ok: false, isGit: false };
			}
			if (!(signal && signal.aborted)) setBoundedClientCache(detectCache, path, { at: Date.now(), value });
			return value;
		}

		/* ================================================================ */
		/* shared bits: checks ring, popover, menu                           */
		/* ================================================================ */

		function ChecksRing({ checks }) {
			const radius = 5;
			const circ = 2 * Math.PI * radius;
			const total = Math.max(checks.total || 0, 1);
			const frac = Math.min((checks.completed || 0) / total, 1);
			const color =
				checks.status === "failure" ? "var(--dsh-bw-red)" :
				checks.status === "pending" ? "var(--dsh-bw-yellow)" : "var(--dsh-bw-green)";
			return h("svg", {
				width: 12, height: 12, viewBox: "0 0 12 12", className: "dsh-bw-ring",
				"aria-label": t("diff.checks", { status: t("checks." + (checks.status || "none")), completed: checks.completed || 0, total: checks.total || 0 }),
			},
				h("circle", { cx: 6, cy: 6, r: radius, fill: "none", stroke: "currentColor", opacity: 0.22, strokeWidth: 2 }),
				frac > 0 && h("circle", {
					cx: 6, cy: 6, r: radius, fill: "none", stroke: color, strokeWidth: 2,
					strokeDasharray: (frac * circ).toFixed(2) + " " + circ.toFixed(2),
					transform: "rotate(-90 6 6)", strokeLinecap: "round",
				}));
		}

		function PrNumBadge({ pr }) {
			const colorClass = pr.state === "merged" ? "dsh-bw-purple" : pr.state === "open" ? "dsh-bw-green" : "dsh-bw-red";
			return h("span", { className: cx("dsh-bw-badge dsh-bw-pr-num", colorClass) }, "#" + pr.number);
		}

		/* git-branch glyph, stroke style to match the shell's hero icons */
		/* raw SVG string for DOM injection into shell workspace rows (the React
		 * BranchIcon below is for our own renders; injected nodes need markup) */
		const WT_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="4.75" cy="3.6" r="1.85"></circle><circle cx="4.75" cy="12.4" r="1.85"></circle><circle cx="11.6" cy="5.15" r="1.85"></circle><path d="M4.75 5.45v5.1"></path><path d="M11.6 7c0 2.85-2.55 3.35-4.55 3.65"></path></svg>';

		function BranchIcon(props) {
			return h("svg", Object.assign({
				width: "1em", height: "1em", viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round",
				"aria-hidden": "true", focusable: "false",
				style: { flex: "none", display: "block" },
			}, props || {}),
				h("circle", { cx: 4.75, cy: 3.6, r: 1.85 }),
				h("circle", { cx: 4.75, cy: 12.4, r: 1.85 }),
				h("circle", { cx: 11.6, cy: 5.15, r: 1.85 }),
				h("path", { d: "M4.75 5.45v5.1" }),
				h("path", { d: "M11.6 7c0 2.85-2.55 3.35-4.55 3.65" }));
		}

		/* GitHub mark (octicon path, currentColor) — the composer's third
		 * attach button, sitting to the RIGHT of the native "+" and paperclip.
		 * The two native controls are hardcoded in the official InputBar and
		 * are deliberately left untouched: no slot can render between them, so
		 * this control is additive (ADR 0008). */
		function ForgeIcon(props) {
			return h("svg", Object.assign({
				width: "1em", height: "1em", viewBox: "0 0 16 16", fill: "currentColor",
				"aria-hidden": "true", focusable: "false",
				style: { flex: "none", display: "block" },
			}, props || {}),
				h("path", { d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995 7.995 0 0016 8c0-4.42-3.58-8-8-8z" }));
		}

		function Popover({ trigger, children, align, panelClass }) {
			const [open, setOpen] = useState(false);
			const ref = useRef(null);
			const opener = useRef(null);
			const close = (restoreFocus = true) => {
				setOpen(false);
				const target = restoreFocus ? opener.current : null;
				if (target && typeof target.focus === "function") queueMicrotask(() => { if (target.isConnected) target.focus(); });
			};
			useEffect(() => {
				if (!open) return undefined;
				const onDoc = (event) => {
					if (ref.current && !ref.current.contains(event.target)) close(false);
				};
				const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } };
				document.addEventListener("mousedown", onDoc);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", onDoc);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			return h("div", { className: "dsh-bw-pop", ref },
				trigger({ open, toggle: () => {
					if (!open) opener.current = document.activeElement;
					open ? close() : setOpen(true);
				} }),
				open && h("div", { className: cx("dsh-bw-pop-panel", align === "right" && "dsh-bw-pop-right", panelClass) }, children(close)));
		}

		function MenuList({ items, onSelect }) {
			return h("div", { className: "dsh-bw-menu" },
				items.map((item) =>
					item.separator
						? h("div", { key: item.id, className: "dsh-bw-menu-sep" })
						: h("button", {
							key: item.id, type: "button", "aria-pressed": item.active === undefined ? undefined : Boolean(item.active),
							className: cx("dsh-bw-menu-item", item.active && "dsh-bw-menu-item-active"),
							disabled: Boolean(item.disabled), title: item.disabled ? item.reason || undefined : item.title || undefined,
							onClick: () => { if (!item.disabled) onSelect(item.id); },
						},
							h("span", { className: "dsh-bw-menu-label" }, item.label),
							item.hint ? h("span", { className: "dsh-bw-menu-hint" }, item.hint) : null)));
		}

		function StatusLetter({ status }) {
			const letter = status === "added" ? "A" : status === "deleted" ? "D" : status === "renamed" ? "R" : status === "copied" ? "C" : status === "binary" ? "B" : status === "too_large" ? "L" : status === "type-changed" ? "T" : "M";
			const color = status === "added" ? "dsh-bw-green" : status === "deleted" ? "dsh-bw-red" : status === "renamed" || status === "copied" ? "dsh-bw-yellow" : "";
			return h("span", { className: cx("dsh-bw-statusletter", color) }, letter);
		}

		/**
		 * Find-or-create the Workspace for an absolute path and open its
		 * (reused blank or fresh) session — the hero staging exit and the
		 * post-archive escape hatch share this.
		 */
		/* per-session attribution: the session log is the only per-session signal
		 * in a shared workspace (git state is per-cwd). We page the official
		 * session log and collect paths written by file-writing tools */
		const WRITE_TOOL_NAMES = new Set(["edit", "write", "multiedit", "notebookedit", "str_replace_editor", "str_replace_based_edit_tool"]);
		function collectTouched(node, out, depth) {
			if (!node || depth > 8 || out.size > 500) return;
			if (Array.isArray(node)) {
				for (const item of node) collectTouched(item, out, depth + 1);
				return;
			}
			if (typeof node !== "object") return;
			const name = typeof node.name === "string" ? node.name : typeof node.toolName === "string" ? node.toolName : null;
			if (name && WRITE_TOOL_NAMES.has(name.toLowerCase()) && node.input && typeof node.input === "object") {
				for (const key of ["file_path", "path", "filePath"]) {
					const v = node.input[key];
					if (typeof v === "string" && v !== "") out.add(v);
				}
			}
			for (const key of Object.keys(node)) collectTouched(node[key], out, depth + 1);
		}
		function normalizeTouchedPaths(found, cwd) {
			const out = new Set();
			const root = cwd.endsWith("/") ? cwd : cwd + "/";
			for (const candidate of found) {
				if (candidate.startsWith(root)) out.add(candidate.slice(root.length));
				else if (!candidate.startsWith("/")) out.add(candidate.replace(/^\.\//, ""));
			}
			return out;
		}
		const touchedCache = new Map();
		const touchedSeq = new Map();
		async function sessionTouchedPaths(sessionId, cwd, force) {
			const key = String(sessionId || "") + "\u0000" + String(cwd || "");
			const seq = (touchedSeq.get(key) || 0) + 1;
			setBoundedClientCache(touchedSeq, key, seq);
			const cached = touchedCache.get(key);
			if (!force && cached && Date.now() - cached.at < 20000) return cached.paths;
			let paths = null;
			try {
				const binding = appCtx.sessions.binding ? appCtx.sessions.binding(sessionId) : null;
				const session = binding && binding.session;
				if (session && typeof session.readPage === "function") {
					const found = new Set();
					let through;
					for (let pageIdx = 0; pageIdx < 4; pageIdx += 1) {
						const page = await session.readPage({ maxMessages: 300 }, through);
						const records = page && page.records;
						if (!records) break;
						collectTouched(records, found, 0);
						if (!page.hasMore || records.length === 0) break;
						const seqs = records
							.map((r) => (r && typeof r.seq === "number" ? r.seq : null))
							.filter((v) => v !== null);
						if (seqs.length === 0) break;
						through = Math.min.apply(null, seqs) - 1;
						if (through < 0) break;
					}
					paths = normalizeTouchedPaths(found, cwd);
				}
			} catch { paths = null; }
			if (touchedSeq.get(key) === seq) setBoundedClientCache(touchedCache, key, { at: Date.now(), paths });
			return paths;
		}

		/* sessions.create resolves a bare id string over the gateway but older
		 * builds wrapped it — one normalizer for every call site */
		function normalizeSessionId(raw) {
			if (typeof raw === "string") return raw;
			if (raw && raw.value) return raw.value.sessionId || raw.value.session || raw.value;
			return raw && raw.sessionId ? raw.sessionId : raw;
		}

		function currentSessionId() {
			try {
				const sessions = appCtx.sessions;
				const snap = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : sessions.getSnapshot && sessions.getSnapshot();
				return snap ? snap.current : undefined;
			} catch {
				return undefined;
			}
		}

		function resolveSessionInput(sessions, sessionId) {
			try {
				const scope = sessions && typeof sessions.scope === "function" ? sessions.scope(sessionId) : undefined;
				const conversation = scope && typeof scope.get === "function"
					? scope.get("conversation")
					: appCtx && typeof appCtx.get === "function" ? appCtx.get("conversation") : null;
				if (!scope || !conversation || !conversation.input || typeof conversation.input.for !== "function") return null;
				return conversation.input.for(scope) || null;
			} catch {
				return null;
			}
		}

		function inputSnapshot(input) {
			if (!input) return null;
			if (input.state && typeof input.state.getSnapshot === "function") return input.state.getSnapshot();
			return input.snapshot || null;
		}

		function setInputDraft(input, draft) {
			if (input && typeof input.setDraft === "function") input.setDraft(draft);
			else if (input && input.actions && typeof input.actions.setDraft === "function") input.actions.setDraft(draft);
			else return false;
			const snapshot = inputSnapshot(input);
			return Boolean(snapshot && snapshot.draft === draft);
		}

		function sameAttachmentIds(left, right) {
			return Array.isArray(left) && Array.isArray(right)
				&& left.length === right.length
				&& left.every((id, index) => id === right[index]);
		}

		function readSessionDraft(sessions, sessionId) {
			const input = resolveSessionInput(sessions, sessionId);
			const snapshot = inputSnapshot(input);
			if (!input || !snapshot || typeof snapshot.draft !== "string") return null;
			return {
				input,
				draft: snapshot.draft,
				draftRev: typeof snapshot.draftRev === "number" ? snapshot.draftRev : null,
				attachmentIds: Array.isArray(snapshot.attachmentIds) ? snapshot.attachmentIds.slice() : [],
				occurrenceCount: Array.isArray(snapshot.occurrences) ? snapshot.occurrences.length : 0,
				phase: snapshot.phase || "plain",
			};
		}

		function clearArchiveBlocks(sessionIds, token) {
			let conversation = null;
			try { conversation = appCtx.get("conversation"); } catch { /* unavailable */ }
			for (const sessionId of sessionIds || []) {
				if (workspaceArchiveBlocks.get(sessionId) !== token) continue;
				workspaceArchiveBlocks.delete(sessionId);
				try { if (conversation && conversation.blocks) conversation.blocks.set(sessionId, undefined); } catch { /* teardown */ }
			}
		}

		function sessionsHaveEmptyDrafts(sessions, sessionIds) {
			if (!Array.isArray(sessionIds)) return false;
			return sessionIds.every((sessionId) => {
				const current = readSessionDraft(sessions, sessionId);
				return Boolean(current && current.phase === "plain" && current.draft === ""
					&& current.attachmentIds.length === 0 && current.occurrenceCount === 0);
			});
		}

		function transferSessionDraft(sessions, sourceId, targetId, captured, conversation) {
			const source = captured && captured.input ? captured : readSessionDraft(sessions, sourceId);
			const liveSource = readSessionDraft(sessions, sourceId);
			const target = readSessionDraft(sessions, targetId);
			if (!source || !liveSource || liveSource.input !== source.input || !target || sourceId === targetId
				|| source.phase !== "plain" || target.phase !== "plain") return false;
			if (source.occurrenceCount > 0 || target.draft !== "" || target.attachmentIds.length > 0) return false;
			if (source.attachmentIds.length > 0
				&& (!conversation || typeof conversation.rebindDraftFiles !== "function"
					|| typeof target.input.addAttachments !== "function"
					|| typeof target.input.removeAttachment !== "function"
					|| typeof source.input.addAttachments !== "function"
					|| typeof source.input.removeAttachment !== "function")) return false;
			const sourceStillMatches = () => {
				const current = inputSnapshot(source.input);
				return Boolean(current && current.phase === "plain" && current.draft === source.draft
					&& (source.draftRev === null || current.draftRev === source.draftRev)
					&& sameAttachmentIds(current.attachmentIds || [], source.attachmentIds));
			};
			if (!sourceStillMatches()) return false;
			let attachmentsAdded = false;
			let sourceClearRev = null;
			const rollbackTarget = () => {
				const targetNow = inputSnapshot(target.input);
				if (targetNow && targetNow.draft === source.draft) setInputDraft(target.input, "");
				if (attachmentsAdded) {
					const sourceNow = inputSnapshot(source.input);
					const sourceIds = Array.isArray(sourceNow?.attachmentIds) ? sourceNow.attachmentIds : [];
					if (!source.attachmentIds.every((id) => sourceIds.includes(id))) return;
					try { conversation.rebindDraftFiles(sourceId, source.attachmentIds); } catch { return; }
					for (const id of source.attachmentIds) {
						try { target.input.removeAttachment(id); } catch { /* a duplicate is safer than loss */ }
					}
				}
			};
			const restoreSourceIfOwned = () => {
				let current = inputSnapshot(source.input);
				if (!current) return;
				const currentIds = Array.isArray(current.attachmentIds) ? current.attachmentIds : [];
				const missing = source.attachmentIds.filter((id) => !currentIds.includes(id));
				try { if (missing.length > 0) source.input.addAttachments(missing); } catch { /* target retains a duplicate */ }
				current = inputSnapshot(source.input);
				const restoredIds = Array.isArray(current?.attachmentIds) ? current.attachmentIds : [];
				if (attachmentsAdded && source.attachmentIds.every((id) => restoredIds.includes(id))) {
					try { conversation.rebindDraftFiles(sourceId, source.attachmentIds); } catch { /* target remains bound */ }
				}
				if (current && current.phase === "plain" && current.draft === ""
					&& (sourceClearRev === null || current.draftRev === sourceClearRev)) {
					setInputDraft(source.input, source.draft);
				}
			};
			try {
				if (source.attachmentIds.length > 0) {
					if (!target.input.addAttachments(source.attachmentIds)) return false;
					attachmentsAdded = true;
					conversation.rebindDraftFiles(targetId, source.attachmentIds);
				}
				if (!setInputDraft(target.input, source.draft) || !sourceStillMatches()) {
					rollbackTarget();
					return false;
				}
				if (!setInputDraft(source.input, "")) {
					rollbackTarget();
					return false;
				}
				sourceClearRev = inputSnapshot(source.input)?.draftRev ?? null;
				for (const id of source.attachmentIds) {
					if (!source.input.removeAttachment(id)) {
						restoreSourceIfOwned();
						rollbackTarget();
						return false;
					}
				}
				const cleared = inputSnapshot(source.input);
				if (!cleared || cleared.phase !== "plain" || cleared.draft !== "" || (cleared.attachmentIds || []).length !== 0) {
					restoreSourceIfOwned();
					rollbackTarget();
					return false;
				}
				sessions.open(targetId);
				return true;
			} catch (error) {
				restoreSourceIfOwned();
				rollbackTarget();
				throw error;
			}
		}

		/* rename with the -2 collision fallback; false when both attempts fail.
		 * The controller face is positional — rename(workspaceId, title) — and
		 * throws RemoteError-shaped failures instead of returning {ok:false} */
		function renameErrorCode(e) {
			if (!e) return null;
			return e.code || (e.error && e.error.code) || (e.details && e.details.code) || null;
		}
		async function renameWorkspaceTolerant(workspaces, lifecycle, workspaceId, title) {
			const live = () => lifecycle !== 0 && activeLifecycleEpoch === lifecycle;
			if (!live()) return false;
			try {
				await workspaces.rename(workspaceId, title);
				return live();
			} catch (e) {
				if (!live() || renameErrorCode(e) !== "workspace/name-conflict") return false;
				try {
					await workspaces.rename(workspaceId, title + "-2");
					return live();
				} catch {
					return false;
				}
			}
		}

		const workspaceRenameQueues = new Map();
		function queueWorkspaceRename(workspaceId, title) {
			const lifecycle = activeLifecycleEpoch;
			const workspaces = appCtx.workspaces;
			const queueKey = `${lifecycle}\u0000${workspaceId}`;
			let state = workspaceRenameQueues.get(queueKey);
			if (!state) {
				state = { desired: title, promise: null };
				workspaceRenameQueues.set(queueKey, state);
			} else state.desired = title;
			if (!state.promise) {
				state.promise = (async () => {
					let outcome;
					for (;;) {
						const target = state.desired;
						outcome = await renameWorkspaceTolerant(workspaces, lifecycle, workspaceId, target);
						if (activeLifecycleEpoch !== lifecycle || state.desired === target) return outcome;
					}
				})().finally(() => {
					if (workspaceRenameQueues.get(queueKey) === state) workspaceRenameQueues.delete(queueKey);
				});
			}
			return state.promise;
		}

		function workspaceSnapshot() {
			const workspaces = appCtx.workspaces;
			if (!workspaces) return { items: [], archivedSessionIds: [] };
			if (workspaces.list && workspaces.list.getSnapshot) {
				return workspaces.list.getSnapshot() || { items: [], archivedSessionIds: [] };
			}
			return { items: workspaces.items || [], archivedSessionIds: workspaces.archivedSessionIds || [] };
		}

		function workspaceItems() {
			return workspaceSnapshot().items || [];
		}

		/* workspaces.create resolves the Workspace object ITSELF (gateway
		 * contract, dsh-git-worktree pre-session controller parity) — the old
		 * {ok,value} assumption threw "workspace create failed" right after a
		 * successful create, leaving orphan workspace rows behind */
		const workspaceMutationLeases = new Map();
		function acquireWorkspaceMutation(cwd) {
			const key = String(cwd || "");
			if (!key || workspaceMutationLeases.has(key)) return null;
			const owner = {};
			workspaceMutationLeases.set(key, owner);
			return () => { if (workspaceMutationLeases.get(key) === owner) workspaceMutationLeases.delete(key); };
		}

		let deferredRecoveryRunning = false;
		async function recoverDeferredWorkspaceDeletions(signal) {
			if (deferredRecoveryRunning || signal?.aborted) return;
			deferredRecoveryRunning = true;
			try {
				for (const mainWorkspace of workspaceItems()) {
					if (signal?.aborted) return;
					let detected;
					try { detected = await detectPath(mainWorkspace.path, signal); } catch { continue; }
					if (!detected || !detected.isGit || detected.isLinkedWorktree
						|| detected.mainRepoRoot !== mainWorkspace.path) continue;
					let pending;
					try { pending = await apiGet("/worktrees/deferred" + qs({ cwd: mainWorkspace.path }), signal); } catch { continue; }
					if (!pending || !pending.ok || !Array.isArray(pending.items)) continue;
					for (const record of pending.items) {
						if (signal?.aborted || !record || typeof record.workspaceId !== "string"
							|| !Array.isArray(record.sessionIds)) continue;
						const targetWorkspace = workspaceItems().find((item) => item.workspaceId === record.workspaceId);
						if (!targetWorkspace) {
							try { await apiPost("/worktrees/finalize-delete", { cwd: mainWorkspace.path, token: record.token }, signal); } catch { /* retry later */ }
							continue;
						}
						if (targetWorkspace.path !== record.path) continue;
						const ids = record.sessionIds.map(String);
						const alreadyArchived = new Set((workspaceSnapshot().archivedSessionIds || []).map(String));
						const needsArchive = ids.filter((id) => !alreadyArchived.has(id));
						// Historical journals may predate the retiring-lease policy. Never
						// infer cross-page draft ownership during recovery; only finalize a
						// transaction whose Session retirement is already durable.
						if (needsArchive.length > 0) continue;
						try {
							await apiPost("/worktrees/finalize-delete", { cwd: mainWorkspace.path, token: record.token }, signal);
						} catch { /* durable record remains for a later pass */ }
					}
				}
			} finally {
				deferredRecoveryRunning = false;
			}
		}

		const workspaceOpenFlights = new Map();
		async function openWorkspaceFor(path, expectedSessionId) {
			const lifecycle = activeLifecycleEpoch;
			const workspaces = appCtx.workspaces;
			const sessions = appCtx.sessions;
			const key = path + "\u0000" + (expectedSessionId || "");
			if (workspaceOpenFlights.has(key)) return workspaceOpenFlights.get(key);
			const flight = (async () => {
				const currentStillOwned = () => lifecycle !== 0 && activeLifecycleEpoch === lifecycle
					&& (!expectedSessionId || currentSessionId() === expectedSessionId);
				if (!currentStillOwned()) throw ownershipError();
				let workspace = workspaceItems().find((w) => w.path === path);
				if (!workspace) {
					workspace = await workspaces.create({ path });
					if (!workspace || workspace.path !== path) throw new Error(failureMessage(workspace) || "workspace create failed");
				}
				if (!currentStillOwned()) throw ownershipError();
				const sessionId = normalizeSessionId(await sessions.create({ workspaceId: workspace.workspaceId }));
				if (!sessionId) throw new Error("session create failed");
				if (!currentStillOwned()) {
					try { await workspaces.archiveSession(sessionId); } catch { /* exact unused target */ }
					throw ownershipError();
				}
				sessions.open(sessionId);
				return { sessionId, workspace };
			})();
			workspaceOpenFlights.set(key, flight);
			try { return await flight; }
			finally { if (workspaceOpenFlights.get(key) === flight) workspaceOpenFlights.delete(key); }
		}

		/* ================================================================ */
		/* sidebar badges                                                    */
		/* ================================================================ */

		function syncOf(snapshot) {
			if (snapshot.gitKnown && snapshot.gitKnown.head === false) return { ahead: null, behind: null };
			const originKnown = !snapshot.gitKnown || snapshot.gitKnown.originDelta !== false;
			const ahead = snapshot.upstream ? snapshot.upstream.ahead : originKnown && snapshot.originDelta ? snapshot.originDelta.ahead : null;
			const behind = snapshot.upstream ? snapshot.upstream.behind : originKnown && snapshot.originDelta ? snapshot.originDelta.behind : null;
			return { ahead, behind };
		}

		function Badges({ cwd }) {
			const snapshot = useStore(feed.store, (s) => (cwd ? s.byCwd[cwd] : undefined));
			useEffect(() => {
				if (!cwd) return undefined;
				feed.track(cwd);
				return () => feed.untrack(cwd);
			}, [cwd]);
			if (!snapshot || !snapshot.isGit) return null;
			const badges = [];
			const known = snapshot.gitKnown || {};
			const branchName = known.head === false ? null : snapshot.branch ?? (snapshot.detached ? "@" + (snapshot.detachedShort || "") : null);
			if (branchName) {
				badges.push(h("span", { key: "br", className: "dsh-bw-badge dsh-bw-badge-branch", title: branchName }, branchName));
			}
			if (known.head !== false && snapshot.pr && snapshot.pr.number) {
				badges.push(h(PrNumBadge, { key: "pr", pr: snapshot.pr }));
				if (snapshot.pr.checks && snapshot.pr.checks.status !== "none" && (snapshot.pr.checks.total || 0) > 0) {
					badges.push(h(ChecksRing, { key: "ck", checks: snapshot.pr.checks }));
				}
			}
			const stat = known.diffStat === false ? null : snapshot.diffStat;
			if (stat && (stat.additions > 0 || stat.deletions > 0)) {
				badges.push(h("span", { key: "ds", className: "dsh-bw-badge dsh-bw-badge-diff" },
					stat.additions > 0 ? h("span", { className: "dsh-bw-green" }, "+" + fmtNum(stat.additions)) : null,
					stat.additions > 0 && stat.deletions > 0 ? " " : null,
					stat.deletions > 0 ? h("span", { className: "dsh-bw-red" }, "−" + fmtNum(stat.deletions)) : null));
			}
			const sync = syncOf(snapshot);
			if ((sync.ahead || 0) > 0 || (sync.behind || 0) > 0) {
				badges.push(h("span", { key: "sy", className: "dsh-bw-badge dsh-bw-badge-diff" },
					(sync.ahead || 0) > 0 ? h("span", { title: "ahead" }, "↑" + sync.ahead) : null,
					(sync.ahead || 0) > 0 && (sync.behind || 0) > 0 ? " " : null,
					(sync.behind || 0) > 0 ? h("span", { title: "behind" }, "↓" + sync.behind) : null));
			}
			if (badges.length === 0) return null;
			return badges;
		}

		function fiberSessionId(element) {
			const key = Object.keys(element).find((k) => k.startsWith("__reactFiber$"));
			if (!key) return null;
			let fiber = element[key];
			let depth = 0;
			while (fiber && depth < 40) {
				const props = fiber.memoizedProps;
				if (props && props.node && typeof props.node === "object" && typeof props.node.id === "string") return props.node.id;
				fiber = fiber.return;
				depth += 1;
			}
			return null;
		}

		function createSidebarInjector(ctx) {
			const roots = new Map(); // container → react root
			let observer = null;
			let timer = null;
			let disposed = false;
			let anchorWarned = false;

			function sessionCwd(sessionId) {
				try {
					const snapshot = ctx.sessions.list.getSnapshot();
					const summary = snapshot.byId[sessionId];
					return summary && typeof summary.cwd === "string" && summary.cwd !== "" ? summary.cwd : null;
				} catch {
					return null;
				}
			}

			/* workspace-row identity (ADR 0001 DOM heuristic): rows are matched
			 * by title text — managed-worktree workspaces swap the folder icon
			 * for the branch icon so their provenance is visible at a glance */
			let managedTitles = null;
			let managedTitleSeq = 0;
			let managedTitleRequest = null;
			async function refreshManagedTitles() {
				const seq = ++managedTitleSeq;
				if (managedTitleRequest) managedTitleRequest.abort();
				managedTitleRequest = new AbortController();
				const signal = managedTitleRequest.signal;
				const titles = new Set();
				// source 1: live git snapshots — any tracked cwd that IS a managed
				// worktree marks its workspace row (works even on old hosts)
				try {
					const snap = feed.store.get();
					const byCwd = (snap && snap.byCwd) || {};
					for (const cwdKey of Object.keys(byCwd)) {
						const entry = byCwd[cwdKey];
						if (!entry || !entry.managed || !entry.isLinkedWorktree) continue;
						const ws = workspaceItems().find((w) => w.path === cwdKey);
						if (ws && typeof ws.title === "string" && ws.title !== "") titles.add(ws.title);
					}
				} catch { /* store not ready yet */ }
				// source 2: host registry route (covers worktrees without sessions)
				try {
					const res = await apiGet("/worktree-workspaces", signal);
					if (res && res.ok && Array.isArray(res.items)) {
						const ids = new Set(res.items.map((i) => i && i.workspaceId).filter(Boolean));
						for (const w of workspaceItems()) {
							if (ids.has(w.workspaceId) && typeof w.title === "string" && w.title !== "") titles.add(w.title);
						}
					}
				} catch { /* older host without the route or superseded */ }
				if (!disposed && !signal.aborted && seq === managedTitleSeq) managedTitles = titles;
			}

			function passWorkspaceIcons() {
				if (disposed || typeof document === "undefined" || managedTitles === null) return;
				let rows;
				try {
					rows = document.querySelectorAll('[class*="_projectRow"]');
				} catch {
					return;
				}
				for (const row of rows) {
					const titleEl = row.querySelector('[class*="_title"]');
					const folderEl = row.querySelector('[class*="_folder"]');
					if (!titleEl || !folderEl) continue;
					const isWt = managedTitles.has(titleEl.textContent || "");
					const marked = folderEl.getAttribute("data-bw-wt") === "1";
					if (isWt && !marked) {
						folderEl.setAttribute("data-bw-wt", "1");
						const icon = document.createElement("span");
						icon.className = "dsh-bw-wt-icon";
						icon.innerHTML = WT_ICON_SVG;
						folderEl.appendChild(icon);
					} else if (!isWt && marked) {
						folderEl.removeAttribute("data-bw-wt");
						const prev = folderEl.querySelector(".dsh-bw-wt-icon");
						if (prev) prev.remove();
					}
				}
			}

			function schedule() {
				if (disposed || timer !== null) return;
				timer = setTimeout(() => {
					timer = null;
					pass();
				}, 300);
			}

			function pass() {
				if (disposed || typeof document === "undefined") return;
				// prune detached containers
				for (const [container, root] of [...roots.entries()]) {
					if (!container.isConnected) {
						try { root.unmount(); } catch { /* gone */ }
						roots.delete(container);
					}
				}
				let rows;
				try {
					rows = document.querySelectorAll('[class*="_sessionRow"]');
				} catch {
					return;
				}
				for (const row of rows) {
					// anchor self-check (ADR 0001): the shipped title span must exist
					if (!row.querySelector('[class*="_title"]')) {
						if (!anchorWarned) {
							anchorWarned = true;
							console.debug("[better-workspaces] session row anchor changed — badges degraded");
						}
						continue;
					}
					const sessionId = fiberSessionId(row);
					if (!sessionId) continue;
					const cwd = sessionCwd(sessionId);
					const rec = row.__dshBw;
					if (rec && rec.container.isConnected && rec.sessionId === sessionId && rec.cwd === cwd) continue;
					if (rec && rec.container.isConnected) {
						// identity or cwd changed → re-render in place when same session, rebuild otherwise
						if (rec.sessionId === sessionId) {
							rec.cwd = cwd;
							const root = roots.get(rec.container);
							if (root) root.render(h(Badges, { cwd }));
							continue;
						}
						try { roots.get(rec.container)?.unmount(); } catch { /* ignore */ }
						rec.container.remove();
						roots.delete(rec.container);
						row.__dshBw = undefined;
					}
					const container = document.createElement("div");
					container.className = "dsh-bw-badges";
					row.appendChild(container);
					const root = react_dom_client.createRoot(container);
					roots.set(container, root);
					row.__dshBw = { container, sessionId, cwd };
					root.render(h(Badges, { cwd }));
				}
				passWorkspaceIcons();
			}

			return {
				start() {
					if (disposed) return;
					try {
						observer = new MutationObserver(schedule);
						observer.observe(document.body, { childList: true, subtree: true });
					} catch {
						observer = null;
					}
					let disposeSessions = () => {};
					try {
						disposeSessions = ctx.sessions.list.subscribe(schedule) || (() => {});
					} catch { /* no store */ }
					this._disposeSessions = disposeSessions;
					let disposeWorkspaces = () => {};
					try {
						if (ctx.workspaces && ctx.workspaces.list && ctx.workspaces.list.subscribe) {
							disposeWorkspaces = ctx.workspaces.list.subscribe(() => {
								refreshManagedTitles().then(schedule);
							}) || (() => {});
						}
					} catch { /* no store */ }
					this._disposeWorkspaces = disposeWorkspaces;
					refreshManagedTitles().then(() => { if (!disposed) passWorkspaceIcons(); });
					pass();
					// gentle keep-alive: React reorders rows without DOM add/remove at times
					this._interval = setInterval(() => { if (!disposed) pass(); }, 5000);
				},
				dispose() {
					disposed = true;
					if (managedTitleRequest) managedTitleRequest.abort();
					if (timer !== null) clearTimeout(timer);
					try { observer && observer.disconnect(); } catch { /* ignore */ }
					try { this._disposeSessions && this._disposeSessions(); } catch { /* ignore */ }
					try { this._disposeWorkspaces && this._disposeWorkspaces(); } catch { /* ignore */ }
					if (this._interval) clearInterval(this._interval);
					try {
						for (const el of document.querySelectorAll('[data-bw-wt]')) {
							el.removeAttribute("data-bw-wt");
							const icon = el.querySelector(".dsh-bw-wt-icon");
							if (icon) icon.remove();
						}
					} catch { /* no dom */ }
					for (const [container, root] of roots.entries()) {
						try { root.unmount(); } catch { /* ignore */ }
						try { container.remove(); } catch { /* ignore */ }
					}
					roots.clear();
				},
			};
		}

		/* ================================================================ */
		/* hero worktree control                                             */
		/* ================================================================ */

		/* paseo-style mnemonic placeholder slug (createNameId equivalent):
		 * adj-noun-hhhh — always a valid branch slug (lowercase, single hyphens). */
		const MNEMONIC_ADJ = ["amber", "brave", "calm", "clever", "coral", "cosmic", "crimson", "curious", "daring", "dusty", "eager", "electric", "emerald", "fading", "fierce", "floating", "gentle", "gilded", "golden", "hidden", "hollow", "humble", "icy", "indigo", "iron", "ivory", "jagged", "jolly", "keen", "lively", "lunar", "mellow", "misty", "molten", "muted", "nifty", "nimble", "noble", "pale", "patient", "polar", "proud", "quiet", "radiant", "rapid", "rustic", "sage", "scarlet", "serene", "shadow", "shifting", "silent", "silver", "solar", "solid", "somber", "swift", "tender", "tranquil", "umber", "vast", "velvet", "vivid", "wandering", "warm", "wild", "winter", "witty", "zealous"];
		const MNEMONIC_NOUN = ["anchor", "arrow", "aurora", "badger", "basalt", "beacon", "birch", "blossom", "brook", "canyon", "cedar", "cinder", "cipher", "cliff", "comet", "copper", "creek", "crest", "crystal", "current", "dawn", "delta", "dune", "ember", "estuary", "falcon", "fen", "fjord", "flint", "forest", "forge", "fossil", "gale", "galaxy", "garden", "geode", "glacier", "glade", "granite", "grove", "harbor", "heron", "horizon", "island", "ivy", "lagoon", "lantern", "larch", "lava", "leaf", "lynx", "marsh", "meadow", "meteor", "monsoon", "moss", "nebula", "oak", "oasis", "opal", "orbit", "otter", "peak", "pebble", "pine", "prairie", "quartz", "quill", "raven", "reef", "ridge", "river", "rose", "sable", "sequoia", "shoal", "sparrow", "spring", "steppe", "stone", "summit", "talon", "thicket", "tide", "timber", "tundra", "vale", "vine", "walrus", "willow", "wolf", "wren", "yarrow"];
		const heroCreateTransactions = new Map();
		const heroCreateBlocks = new Map();
		const workspaceArchiveBlocks = new Map();
		const HERO_TX_PREFIX = "dsh.better-workspaces.create.";

		function newCreationTxId() {
			try {
				if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
			} catch { /* fallback below */ }
			return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
		}

		function creationRequestKey(selection) {
			return JSON.stringify(selection);
		}

		function heroCreationRequest(sourceId, selection, makeBody) {
			const requestKey = creationRequestKey(selection);
			let record = heroCreateTransactions.get(sourceId) || null;
			if (!record) {
				try { record = JSON.parse(localStorage.getItem(HERO_TX_PREFIX + sourceId) || "null"); } catch { record = null; }
			}
			if (!record || typeof record.txId !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(record.txId)
				|| !record.body || typeof record.body !== "object" || Array.isArray(record.body)) {
				const txId = newCreationTxId();
				record = { requestKey, txId, targetSessionId: "session-" + txId, body: makeBody() };
			} else if (record.requestKey !== requestKey) {
				// Unknown settlement always converges before a different semantic
				// choice may mint another worktree for this launcher.
				record = { ...record, selectionConflict: true };
			}
			if (record.targetSessionId !== "session-" + record.txId) {
				record = { ...record, targetSessionId: "session-" + record.txId };
			}
			heroCreateTransactions.set(sourceId, record);
			try { localStorage.setItem(HERO_TX_PREFIX + sourceId, JSON.stringify(record)); } catch { /* memory fallback */ }
			return record;
		}

		function clearHeroCreationTx(sourceId, txId) {
			const record = heroCreateTransactions.get(sourceId);
			if (record && record.txId !== txId) return;
			heroCreateTransactions.delete(sourceId);
			try { localStorage.removeItem(HERO_TX_PREFIX + sourceId); } catch { /* memory-only */ }
		}

		function mnemonicSlug() {
			const adj = MNEMONIC_ADJ[Math.floor(Math.random() * MNEMONIC_ADJ.length)];
			const noun = MNEMONIC_NOUN[Math.floor(Math.random() * MNEMONIC_NOUN.length)];
			const hex = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
			return adj + "-" + noun + "-" + hex;
		}

		/* pure helpers (unit-tested via __bwTest) */

		/** Last path segment, tolerant of trailing slashes. */
		function basenameOf(p) {
			const s = String(p || "").replace(/\/+$/, "");
			const i = s.lastIndexOf("/");
			return i >= 0 ? s.slice(i + 1) : s;
		}

		/** Exact failure text from any {message}|{error:string}|{error:{message}} shape. */
		function failureMessage(result) {
			if (!result) return null;
			if (typeof result.message === "string" && result.message) return result.message;
			const err = result.error;
			if (typeof err === "string" && err) return err;
			if (err && typeof err.message === "string" && err.message) return err.message;
			return null;
		}

		/* hero mode menu: two items, one active — 本地 (the workspace root IS
		 * the repository checkout) vs 新建 worktree (staging). ADR 0002/0004
		 * Phase A both specify both entries; a single-item menu stranded the
		 * user in the branch picker with no way back to 本地. */
		function heroModeItems(staging, translate) {
			return [
				{ id: "local", label: translate("hero.modeLocal"), active: !staging },
				{ id: "new", label: translate("hero.modeWorktree"), active: staging },
			];
		}

		/* A path-resolved async value is only valid for the path it was
		 * resolved for. The session switch renders with the NEW cwd and the
		 * OLD detect until the new detection lands (the detect-reset and
		 * title-sync effects run in the same commit, and the reset only takes
		 * effect on the next render) — consuming the old value under the new
		 * cwd renamed the WRONG workspace (its title became
		 * "<old worktree's source workspace> · <new session title>").
		 * Tag every detect result with its cwd and read it through here. */
		function liveDetect(entry, cwd, sessionId) {
			return entry && cwd && entry.cwd === cwd
				&& (entry.sessionId === undefined || entry.sessionId === sessionId) ? entry.value : null;
		}

		function HeroControl() {
			const sessions = appCtx.sessions;
			const listState = useSyncExternalStore(
				sessions.list.subscribe,
				() => sessions.list.getSnapshot(),
				() => sessions.list.getSnapshot(),
			);
			const currentId = listState.current;
			const summary = currentId ? listState.byId[currentId] : undefined;
			const cwd = summary && typeof summary.cwd === "string" && summary.cwd !== "" ? summary.cwd : null;
			return h(HeroControlResource, {
				key: `${currentId || ""}\u0000${cwd || ""}`, sessions, currentId, summary, cwd,
			});
		}

		function HeroControlResource(props) {
			const { currentId, summary, cwd } = props;
			// cwd-tagged detection: {cwd, value} — see liveDetect above
			const [detect, setDetect] = useState(null);
			const [staging, setStaging] = useState(false);
			const [branchPick, setBranchPick] = useState(null); // null → default
			const [newBranch, setNewBranch] = useState(false);
			const [newBranchName, setNewBranchName] = useState("");
			const [explicitName, setExplicitName] = useState(null); // user-named branch (staging)
			const [branches, setBranches] = useState(null);
			const [pulls, setPulls] = useState(null);
			const [pullsError, setPullsError] = useState(null);
			const [busy, setBusy] = useState(null);
			const [error, setError] = useState(null);
			const requestOwner = useRef(null);
			if (!requestOwner.current) requestOwner.current = createRequestOwner();
			const operation = useRef(null);

			useEffect(() => {
				requestOwner.current.reset();
				operation.current = null;
				setBusy(null);
				const ownedSessionId = currentId;
				return () => {
					requestOwner.current.reset();
					const blockedToken = heroCreateBlocks.get(ownedSessionId);
					if (!blockedToken) return;
					heroCreateBlocks.delete(ownedSessionId);
					try {
						const conversation = appCtx.get("conversation");
						if (conversation && conversation.blocks) conversation.blocks.set(ownedSessionId, undefined);
					} catch { /* component teardown must not retain a block */ }
				};
			}, [currentId, cwd]);

			function resetStaging() {
				setStaging(false);
				setBranchPick(null);
				setNewBranch(false);
				setNewBranchName("");
				setExplicitName(null);
				setError(null);
				setPullsError(null);
			}

			useEffect(() => {
				resetStaging();
				setBranches(null);
				setPulls(null);
				setPullsError(null);
				if (!cwd) {
					setDetect(null);
					return undefined;
				}
				const token = requestOwner.current.begin("detect");
				setDetect(null);
				detectPath(cwd, token.controller.signal)
					.then((value) => { if (requestOwner.current.owns(token)) setDetect({ cwd, sessionId: currentId, value }); })
					.catch(() => {})
					.finally(() => requestOwner.current.end(token));
				return () => requestOwner.current.abort(token);
			}, [cwd, currentId]);

			// never read a detection resolved for another cwd
			const det = liveDetect(detect, cwd, currentId);
			const liveBranches = branches && branches.cwd === cwd ? branches.value : null;
			const livePulls = pulls && pulls.cwd === cwd ? pulls.value : null;

			/* worktree-session workspace title follows EVERY session title, not just
			 * the first one: dsh publishes a throwaway fallback title derived from
			 * the prompt text immediately and the model's title about a second later,
			 * so a one-shot latch froze sidebar rows on the fallback forever
			 * (observed: row "dsh-better-workspaces · 请给dsh-better-workspaces…"
			 * while the session row showed its real title — ADR 0004 Amendment 6.B).
			 * A title this plugin did not compose is a human's rename: left alone.
			 * EVERY hook must run before the non-git early return below —
			 * hooks after a conditional return crash the component with a
			 * hook-count mismatch (the hero dropdown vanished that way once) */
			const lastSyncedTitle = react.useRef(null);
			const summaryTitle = summary && typeof summary.title === "string" ? summary.title : null;
			react.useEffect(() => {
				if (!cwd || !det || !det.isLinkedWorktree || !det.managed) return;
				const ws = workspaceItems().find((w) => w.path === cwd);
				if (!ws) return;
				const prefix = det.sourceWorkspaceTitle || basenameOf(det.mainRepoRoot || det.repoRoot || cwd);
				const current = typeof ws.title === "string" ? ws.title : "";
				const composed = prefix ? prefix + " · " : "";
				// self-heal rows created before provenance titles existed: a bare
				// basename title on a managed worktree gets its prefix back
				const healed = !summaryTitle && prefix && det.branch && current === basenameOf(cwd)
					? composed + det.branch
					: null;
				const title = summaryTitle ? composed + summaryTitle : healed;
				if (!title || current === title) return;
				// only rewrite a title this plugin composed (or the untouched default
				// row title); a hand-picked workspace title is not ours to overwrite
				const ours = composed ? current.indexOf(composed) === 0 : current === basenameOf(cwd);
				if (!ours && !healed) return;
				const attempt = { workspaceId: ws.workspaceId, title };
				if (lastSyncedTitle.current
					&& lastSyncedTitle.current.workspaceId === attempt.workspaceId
					&& lastSyncedTitle.current.title === attempt.title) return;
				lastSyncedTitle.current = attempt;
				(async () => {
					try {
						const renamed = await queueWorkspaceRename(ws.workspaceId, title);
						if (!renamed && lastSyncedTitle.current === attempt) lastSyncedTitle.current = null;
					} catch {
						if (lastSyncedTitle.current === attempt) lastSyncedTitle.current = null;
					}
				})();
			}, [cwd, det, summaryTitle]);

			// worktree workspaces get no hero control: they ARE the pinned
			// result — staging another worktree from inside one is not a flow
			// we offer (the sidebar row keeps its badges; hero hides entirely)
			if (!cwd || !det || !det.isGit || det.isLinkedWorktree) return null;

			async function openBranchList() {
				const token = requestOwner.current.begin("hero-list");
				setStaging(true);
				setError(null);
				setPullsError(null);
				try {
					const jobs = [];
					if (!liveBranches) jobs.push(
						apiGet("/branches" + qs({ cwd }), token.controller.signal)
							.then((result) => {
								requireOwnership(requestOwner.current, token);
								if (result.ok) setBranches({ cwd, value: result });
								else setError(t("hero.failed", { message: result.error || "?" }));
							}),
					);
					/* A forge failure never masks the branch list. */
					if (!livePulls) jobs.push(
						apiGet("/pulls" + qs({ cwd }), token.controller.signal)
							.then((result) => {
								requireOwnership(requestOwner.current, token);
								if (result.ok) {
									for (const item of result.items || []) { const key = forgeItemKey(item); if (key) cacheForgeItem(key, item); }
									setPulls({ cwd, value: result.items || [] });
									if (result.authState === "partial") setPullsError(result.error || t("forge.loadFailed"));
								} else {
									setPulls({ cwd, value: [] });
									setPullsError(failureMessage(result) || t("forge.loadFailed"));
								}
							}),
					);
					await Promise.all(jobs);
				} catch (e) {
					if (requestOwner.current.owns(token)) setError(t("hero.failed", { message: String((e && e.message) || e) }));
				} finally {
					requestOwner.current.end(token);
				}
			}

			/* reference-aligned handoff (dsh-git-worktree pre-session controller,
			 * official APIs only): worktree → workspace → target session → draft
			 * migration → open → retire the source launcher; full rollback on any
			 * failure so a broken attempt leaves no orphan rows.
			 *
			 * `pull` switches the request to the PR-checkout intent (paseo's
			 * checkout-change-request): the hero's PR rows create a worktree
			 * holding the PR's head instead of a branch cut from a base. */
			async function prepareStagedWorktree(baseBranch, explicit, pull) {
				if (operation.current) return;
				const sourceId = currentId;
				if (!sourceId || currentSessionId() !== sourceId) return;
				const releaseMutation = acquireWorkspaceMutation(cwd);
				if (!releaseMutation) return;
				const token = requestOwner.current.begin("hero-create");
				operation.current = token;
				const conversation = appCtx.get("conversation");
				const capturedDraft = readSessionDraft(appCtx.sessions, sourceId);
				setBusy(t(pull ? "hero.checkingOut" : "hero.creating"));
				setError(null);
				let targetId;
				if (conversation && conversation.blocks) {
					heroCreateBlocks.set(sourceId, token);
					try { conversation.blocks.set(sourceId, { reason: t("hero.blockReason") }); } catch { /* cosmetic */ }
				}
				const items0 = workspaceItems();
				const srcWs =
					items0.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sourceId) !== -1) ||
					items0.find((w) => w.path === cwd) || null;
				const sourceTitle =
					(srcWs && typeof srcWs.title === "string" && srcWs.title.trim()) ||
					basenameOf(det.mainRepoRoot || det.repoRoot || cwd) || "";
				const named = explicit || explicitName;
				const selection = {
					cwd,
					intent: pull ? "pr-checkout" : "branch-off",
					branchName: !pull && named ? named : null,
					base: !pull && !named ? baseBranch || branchPick || defaultBaseRef() || null : null,
					pull: pull ? {
						host: pull.host,
						owner: pull.owner,
						repo: pull.repo,
						number: pull.number,
						headRef: pull.headRefName,
						baseRef: pull.baseRefName || null,
						forkOwner: pull.fork && pull.headOwnerLogin ? pull.headOwnerLogin : null,
					} : null,
				};
				const pending = heroCreationRequest(sourceId, selection, () => {
					const body = {
						cwd,
						sourceSessionId: sourceId,
						intent: pull ? "checkout" : "branch-off",
						slug: mnemonicSlug(),
						sourceTitle,
					};
					if (selection.pull) body.pull = selection.pull;
					else if (selection.branchName) body.branchName = selection.branchName;
					else if (selection.base) body.base = selection.base;
					return body;
				});
				try {
					if (!capturedDraft) throw new Error("source composer is unavailable");
					const body = { ...pending.body, txId: pending.txId };
					// Creation is idempotent by txId. Do not abort the mutation after it
					// was sent: a lost response must remain forward-retryable.
					const result = await apiPost("/worktrees", body);
					requireOwnership(requestOwner.current, token);
					if (currentSessionId() !== sourceId) throw ownershipError();
					if (!result.ok) {
						if (result.txState === "retired" || result.txState === "absent") {
							clearHeroCreationTx(sourceId, pending.txId);
						}
						throw new Error(failureMessage(result) || result.error || "worktree create failed");
					}
					setBusy(t("hero.switching"));
					if (typeof result.workspaceId !== "string" || result.workspaceId === "") throw new Error("workspace receipt unavailable");
					let workspace = workspaceItems().find((item) => item.workspaceId === result.workspaceId) || null;
					if (!workspace) workspace = await appCtx.workspaces.create({ path: result.path });
					requireOwnership(requestOwner.current, token);
					if (currentSessionId() !== sourceId) throw ownershipError();
					if (!workspace || workspace.path !== result.path || workspace.workspaceId !== result.workspaceId) {
						throw new Error("workspace receipt no longer owns the created path");
					}
					const workspaceId = result.workspaceId;
					await queueWorkspaceRename(workspaceId, (sourceTitle ? sourceTitle + " · " : "") + (result.branch || ""));
					requireOwnership(requestOwner.current, token);
					if (currentSessionId() !== sourceId) throw ownershipError();
					try {
						targetId = normalizeSessionId(await appCtx.sessions.create({
							workspaceId,
							sessionId: pending.targetSessionId,
						}));
					} catch (createError) {
						const converged = workspaceItems().find((item) => item.workspaceId === workspaceId
							&& item.path === result.path && Array.isArray(item.sessionIds)
							&& item.sessionIds.map(String).includes(pending.targetSessionId));
						if (!converged) throw createError;
						targetId = pending.targetSessionId;
					}
					requireOwnership(requestOwner.current, token);
					if (currentSessionId() !== sourceId) throw ownershipError();
					if (typeof targetId !== "string" || targetId === "") throw new Error("session create failed");
					if (!transferSessionDraft(appCtx.sessions, sourceId, targetId, capturedDraft, conversation)) {
						throw new Error("draft handoff was not committed");
					}
					clearHeroCreationTx(sourceId, pending.txId);
					try { await appCtx.workspaces.archiveSession(sourceId); } catch { /* target already owns the draft */ }
				} catch (e) {
					if (requestOwner.current.owns(token) && currentSessionId() === sourceId) {
						setError(t("hero.failed", { message: String((e && e.message) || e) }));
					}
				} finally {
					if (conversation && conversation.blocks && heroCreateBlocks.get(sourceId) === token) {
						heroCreateBlocks.delete(sourceId);
						try { conversation.blocks.set(sourceId, undefined); } catch { /* cosmetic */ }
					}
					if (requestOwner.current.owns(token) && currentSessionId() === sourceId) setBusy(null);
					requestOwner.current.end(token);
					if (operation.current === token) operation.current = null;
					releaseMutation();
				}
			}

			function refDisplay(ref) {
				if (typeof ref !== "string") return "";
				if (ref.indexOf("refs/heads/") === 0) return ref.slice("refs/heads/".length);
				if (ref.indexOf("refs/remotes/origin/") === 0) return ref.slice("refs/remotes/origin/".length);
				return ref;
			}

			function defaultBaseRef() {
				if (!liveBranches || !liveBranches.defaultBranch) return null;
				const entry = (liveBranches.branches || []).find((b) => b.name === liveBranches.defaultBranch);
				if (entry && entry.hasRemote) return "refs/remotes/origin/" + entry.name;
				if (entry && entry.hasLocal) return "refs/heads/" + entry.name;
				return liveBranches.defaultBranch;
			}

			function confirmExplicitName(close) {
				const name = newBranchName.trim();
				if (!name) return;
				setExplicitName(name);
				setNewBranch(false);
				setBranchPick(null);
				if (close) close();
				prepareStagedWorktree(null, name);
			}

			/* paseo picker parity (new-workspace-picker-item.ts): the origin row
			 * comes first because it IS the default base — cutting from
			 * refs/remotes/origin/<name> starts at the true remote head even
			 * when the local branch lags; the local row shows as
			 * "<name>（本地）" with +N −M divergence when both sides exist */
			const defRef = defaultBaseRef();
			const picked = branchPick || defRef;
			const branchItems = [];
			if (liveBranches) {
				branchItems.push({ id: "__new__", label: t("hero.newBranchItem") });
				branchItems.push({ id: "__sep__", separator: true });
				for (const branch of (liveBranches.branches || []).slice(0, 200)) {
					if (branch.hasRemote) {
						const ref = "refs/remotes/origin/" + branch.name;
						branchItems.push({
							id: ref,
							kind: "branch",
							label: branch.name,
							hint: ref === defRef ? t("hero.default") : null,
							active: picked === ref,
						});
					}
					if (branch.hasLocal) {
						const ref = "refs/heads/" + branch.name;
						const parts = [];
						if (branch.localAhead > 0) parts.push("+" + branch.localAhead);
						if (branch.localBehind > 0) parts.push("\u2212" + branch.localBehind);
						branchItems.push({
							id: ref,
							kind: "branch",
							label: branch.hasRemote ? branch.name + t("hero.localSuffix") : branch.name,
							hint: branch.current ? t("hero.current") : parts.length ? parts.join(" ") : null,
							active: picked === ref,
						});
					}
				}
			}

			/* Open pull requests join the base list (paseo's buildPickerOptionData):
			   one page, newest first, labelled `#N title` with a head → base hint
			   so a PR row cannot read as a branch. Picking one checks the PR's
			   HEAD out — it is not a base to cut from.
			   Issue rows are dropped here, not merely disabled: this list's only
			   selection outcome is worktree creation and an issue has no head to
			   check out (the composer picker is where issues are attached). */
			const prItems = (livePulls || [])
				.filter((item) => item.kind === "change_request" && item.headRefName)
				.map((item) => ({
					id: "pr:" + item.number,
					kind: "change_request",
					label: (item.fork ? t("forge.fork") + " " : "") + "#" + item.number + " " + (item.title || ""),
					hint: "→ " + (item.baseRefName || "?"),
					item,
				}));
			const baseItems = prItems.length > 0
				? branchItems.concat([{ id: "__forge_sep__", separator: true }], prItems)
				: branchItems;

			const effectiveBranch = refDisplay(picked) || "…";

			return h(react.Fragment, null,
				h(Popover, {
					align: "left",
					trigger: ({ open, toggle }) =>
						h("button", {
							type: "button", className: "dsh-bw-hero-btn", onClick: toggle, disabled: Boolean(busy),
							"aria-expanded": open, "aria-label": t(staging ? "hero.modeWorktree" : "hero.modeLocal"),
						},
							h(BranchIcon),
							h("span", { className: "dsh-bw-hero-label" }, busy || t(staging ? "hero.modeWorktree" : "hero.modeLocal")),
							h("span", { className: "dsh-bw-hero-chevron" }, "▾")),
					children: (close) =>
						h(MenuList, {
							items: heroModeItems(staging, t),
							onSelect: (id) => {
								close();
								if (id === "local") { resetStaging(); return; }
								openBranchList();
							},
						}),
				}),
				staging && h(Popover, {
					align: "left",
					trigger: ({ open, toggle }) =>
						h("button", { type: "button", className: "dsh-bw-hero-btn", onClick: toggle, disabled: Boolean(busy), "aria-expanded": open },
							h(BranchIcon),
							h("span", { className: "dsh-bw-hero-label" },
								explicitName
									? t("hero.pickExplicit", { name: explicitName })
									: t("hero.pickBase", { branch: effectiveBranch })),
							h("span", { className: "dsh-bw-hero-chevron" }, "▾")),
					children: (close) =>
						liveBranches === null
							? h("div", { className: "dsh-bw-hero-panel-row" }, t("diff.loading"))
							: newBranch
								? h("div", { className: "dsh-bw-hero-panel-row" },
									h("input", {
										className: "dsh-bw-hero-input", autoFocus: true, "aria-label": t("hero.newBranchItem"), value: newBranchName,
										placeholder: t("hero.newBranchPlaceholder"),
										onChange: (e) => setNewBranchName(e.target.value),
										onKeyDown: (e) => { if (e.key === "Enter" && newBranchName.trim()) confirmExplicitName(close); },
									}),
									h("span", { className: "dsh-bw-menu-hint" }, t("hero.baseHint", { branch: effectiveBranch })),
									h("button", {
										type: "button", className: "dsh-bw-btn dsh-bw-btn-primary", disabled: !newBranchName.trim() || Boolean(busy),
										onClick: () => confirmExplicitName(close),
									}, t("hero.create")))
								: h(MenuList, {
									items: baseItems,
									onSelect: (id) => {
										if (id === "__new__") { setNewBranch(true); setBranchPick(null); setExplicitName(null); return; }
										if (id === "__sep__" || id === "__forge_sep__") return;
										close();
										setNewBranch(false);
										setExplicitName(null);
										const pr = prItems.find((entry) => entry.id === id);
										if (pr) {
											setBranchPick(null);
											prepareStagedWorktree(null, null, pr.item);
											return;
										}
										setBranchPick(id);
										prepareStagedWorktree(id);
									},
								}),
				}),
				staging && pullsError ? h("span", { className: "dsh-bw-hero-error", role: "alert" }, t("forge.pullsFailed", { message: pullsError })) : null,
				staging ? h("span", { className: "dsh-bw-menu-hint" }, t("hero.stageHint")) : null,
				staging ? h("button", {
					type: "button", className: "dsh-bw-btn", disabled: Boolean(busy),
					onClick: () => prepareStagedWorktree(null),
				}, t("hero.stageCreateFallback")) : null,
				error ? h("span", { className: "dsh-bw-hero-error", role: "alert" }, error) : null);
		}

		function createHeroInjector() {
			let container = null;
			let root = null;
			let observer = null;
			let timer = null;
			let disposed = false;
			let anchorWarned = false;

			function teardown() {
				if (root) {
					try { root.unmount(); } catch { /* ignore */ }
					root = null;
				}
				if (container && container.isConnected) container.remove();
				container = null;
			}

			function pass() {
				if (disposed || typeof document === "undefined") return;
				let presetSlot = null;
				try {
					presetSlot = document.querySelector('[data-slot="conversation.hero.agentPreset"]');
				} catch { /* no dom */ }
				const parent = presetSlot && presetSlot.parentElement;
				const isHeroRow =
					parent && typeof parent.className === "string" && parent.className.indexOf("_heroWorkspaceRow") !== -1;
				if (!presetSlot || !parent || !isHeroRow) {
					// anchor self-check (ADR 0001): hero row absent or restructured → silent degradation
					if (presetSlot && parent && !isHeroRow && !anchorWarned) {
						anchorWarned = true;
						console.debug("[better-workspaces] hero row anchor changed — worktree control degraded");
					}
					teardown();
					return;
				}
				if (container && container.isConnected && container.parentElement === parent) return;
				teardown();
				container = document.createElement("div");
				container.className = "dsh-bw-hero";
				parent.insertBefore(container, presetSlot);
				root = react_dom_client.createRoot(container);
				root.render(h(HeroControl, null));
			}

			function schedule() {
				if (disposed || timer !== null) return;
				timer = setTimeout(() => {
					timer = null;
					pass();
				}, 300);
			}

			return {
				start() {
					try {
						observer = new MutationObserver(schedule);
						observer.observe(document.body, { childList: true, subtree: true });
					} catch {
						observer = null;
					}
					pass();
					this._interval = setInterval(() => { if (!disposed) pass(); }, 5000);
				},
				dispose() {
					disposed = true;
					if (timer !== null) clearTimeout(timer);
					try { observer && observer.disconnect(); } catch { /* ignore */ }
					if (this._interval) clearInterval(this._interval);
					teardown();
				},
			};
		}

		/* ================================================================ */
		/* dock pill                                                         */
		/* ================================================================ */

		/** Whether this page can be opened at all: the official right column is up. */
		function sidebarAvailable() {
			return Boolean(appCtx.get("sidebarRight"));
		}

		/**
		 * Open (or reveal) the diff page in the official right Sidebar. The column
		 * expands in the same step, and an already-open diff tab is revealed rather
		 * than duplicated, because a page deduplicates within its pane.
		 */
		function openDiffTab() {
			const sidebarRight = appCtx.get("sidebarRight");
			if (!sidebarRight || typeof sidebarRight.openTab !== "function") return;
			try {
				sidebarRight.openTab(SIDEBAR_DIFF_KIND);
			} catch {
				/* no mounted right-column seat: nothing to open into */
			}
		}

		function snapshotMutationKnown(snapshot) {
			return Boolean(snapshot && (!snapshot.gitKnown
				|| (snapshot.gitKnown.head !== false && snapshot.gitKnown.status !== false)));
		}

		/** The pill's factual label: diffstat, then dirty count, then unpushed, then the bare tab name. */
		function pillLabel(snapshot, translate) {
			const known = snapshot.gitKnown || {};
			const stat = known.head === false || known.diffStat === false ? null : snapshot.diffStat;
			if (stat && (stat.additions > 0 || stat.deletions > 0)) {
				return h("span", null,
					stat.additions > 0 ? h("span", { className: "dsh-bw-green" }, "+" + fmtNum(stat.additions)) : null,
					stat.additions > 0 && stat.deletions > 0 ? " " : null,
					stat.deletions > 0 ? h("span", { className: "dsh-bw-red" }, "−" + fmtNum(stat.deletions)) : null);
			}
			if (known.head !== false && known.status !== false && snapshot.dirty) {
				return h("span", null, translate("pill.dirty", { n: snapshot.changedFileCount || 0 }));
			}
			const ahead = known.head === false ? 0 : snapshot.upstream ? snapshot.upstream.ahead : 0;
			if (ahead > 0) return h("span", null, "↑" + ahead + " " + translate("diff.unpushed"));
			return h("span", null, translate("view.diff"));
		}

		function GitDiffPill(props) {
			const sessionId = props.sessionId;
			const sessions = appCtx.sessions;
			const listState = useSyncExternalStore(
				sessions.list.subscribe,
				() => sessions.list.getSnapshot(),
				() => sessions.list.getSnapshot(),
			);
			const summary = sessionId ? listState.byId[sessionId] : undefined;
			const cwd = summary && typeof summary.cwd === "string" && summary.cwd !== "" ? summary.cwd : null;
			const snapshot = useStore(feed.store, (s) => (cwd ? s.byCwd[cwd] : undefined));
			useEffect(() => {
				if (!cwd) return undefined;
				feed.track(cwd);
				return () => feed.untrack(cwd);
			}, [cwd]);
			// The pill is the diff page's only door: the conversation no longer has
			// a diff tab, so a clean git session keeps the pill (showing "diff")
			// instead of dropping the view out of reach.
			if (!cwd || !snapshot || !snapshot.isGit || !sidebarAvailable()) return null;
			return h("button", {
				type: "button", className: "dsh-bw-pill", title: t("pill.title"),
				onClick: () => openDiffTab(),
			},
				h("span", { className: "dsh-bw-pill-icon" }, "±"),
				pillLabel(snapshot, t));
		}

		/* ================================================================ */
		/* diff view                                                         */
		/* ================================================================ */

		function useCwd(sessionId) {
			const sessions = appCtx.sessions;
			const get = useCallback(() => {
				try {
					const snapshot = sessions.list.getSnapshot();
					const summary = sessionId ? snapshot.byId[sessionId] : undefined;
					return summary && typeof summary.cwd === "string" && summary.cwd !== "" ? summary.cwd : null;
				} catch {
					return null;
				}
			}, [sessionId, sessions]);
			return useSyncExternalStore(sessions.list.subscribe, get, get);
		}

		function useRunning(sessionId) {
			const sessions = appCtx.sessions;
			const get = useCallback(() => {
				try {
					const snapshot = sessions.list.getSnapshot();
					const summary = sessionId ? snapshot.byId[sessionId] : undefined;
					return Boolean(summary && summary.running);
				} catch {
					return false;
				}
			}, [sessionId, sessions]);
			return useSyncExternalStore(sessions.list.subscribe, get, get);
		}

		function Hunk({ hunk, wrap }) {
			let oldNo = hunk.oldStart;
			let newNo = hunk.newStart;
			return h("div", { className: "dsh-bw-hunk" },
				h("div", { className: "dsh-bw-hunkhdr" }, "@@ -" + hunk.oldStart + "," + hunk.oldCount + " +" + hunk.newStart + "," + hunk.newCount + "@@" + (hunk.header ? " " + hunk.header : "")),
				hunk.lines.map((line, index) => {
					let oldCell = "";
					let newCell = "";
					if (line.type === "del" || line.type === "ctx") { oldCell = String(oldNo); oldNo += 1; }
					if (line.type === "add" || line.type === "ctx") { newCell = String(newNo); newNo += 1; }
					return h("div", {
						key: index,
						className: cx("dsh-bw-line", line.type === "add" && "dsh-bw-line-add", line.type === "del" && "dsh-bw-line-del", line.type === "meta" && "dsh-bw-line-meta", wrap && "dsh-bw-wrap"),
					},
						h("span", { className: "dsh-bw-ln" }, oldCell),
						h("span", { className: "dsh-bw-ln" }, newCell),
						h("span", { className: "dsh-bw-code" }, line.content));
				}));
		}


		/* ================================================================ */
		/* file editor (CAS-protected writes via POST /file)                  */
		/* ================================================================ */

		function FileEditor(props) {
			const [text, setText] = useState(props.initialContent != null ? props.initialContent : null);
			const [base, setBase] = useState(props.initialContent != null ? props.initialContent : null);
			const [sha1, setSha1] = useState(props.initialSha1 || null);
			const [saving, setSaving] = useState(false);
			const [error, setError] = useState(null);
			const [conflict, setConflict] = useState(false);
			const requestOwner = useRef(null);
			if (!requestOwner.current) requestOwner.current = createRequestOwner();
			const saveLock = useRef(false);

			const load = useCallback(async () => {
				const token = requestOwner.current.begin("file-load");
				try {
					const r = await apiGet("/file" + qs({ cwd: props.cwd, path: props.path }), token.controller.signal);
					requireOwnership(requestOwner.current, token);
					if (r && r.ok && r.kind === "text") {
						setText(r.content);
						setBase(r.content);
						setSha1(r.sha1 || null);
						setError(null);
						setConflict(false);
					} else setError(t("files.editUnavailable"));
				} catch {
					if (requestOwner.current.owns(token)) setError(t("files.editUnavailable"));
				} finally {
					requestOwner.current.end(token);
				}
			}, [props.cwd, props.path]);

			useEffect(() => {
				if (props.initialContent == null) load();
				return () => requestOwner.current.reset();
			}, [load, props.initialContent]);

			async function save() {
				if (text === null || saveLock.current) return;
				const releaseMutation = acquireWorkspaceMutation(props.cwd);
				if (!releaseMutation) return;
				saveLock.current = true;
				const savedText = text;
				const savedSha1 = sha1;
				const token = requestOwner.current.begin("file-save");
				setSaving(true);
				setError(null);
				try {
					const r = await apiPost("/file", {
						cwd: props.cwd, path: props.path, content: savedText, baseSha1: savedSha1 || undefined,
					}, token.controller.signal);
					requireOwnership(requestOwner.current, token);
					if (r && r.ok) {
						setBase(savedText);
						if (r.sha1) setSha1(r.sha1);
						setConflict(false);
						if (props.onSaved) props.onSaved();
					} else if (r && r.error === "conflict") {
						setConflict(true);
						setError(t("files.conflict"));
					} else setError(failureMessage(r) || t("files.saveFailed"));
				} catch (e) {
					if (requestOwner.current.owns(token)) setError(String((e && e.message) || e));
				} finally {
					if (requestOwner.current.owns(token)) setSaving(false);
					requestOwner.current.end(token);
					saveLock.current = false;
					releaseMutation();
				}
			}

			if (text === null) return h("div", { className: "dsh-bw-empty", role: error ? "alert" : "status", "aria-live": error ? undefined : "polite" }, error || t("diff.loading"));
			const dirty = text !== base;
			return h("div", { className: "dsh-bw-editor" },
				h("div", { className: "dsh-bw-editor-bar" },
					h("span", { className: "dsh-bw-editor-path", title: props.path }, props.path),
					dirty ? h("span", { className: "dsh-bw-editor-dirty" }, "\u25cf") : null,
					h("span", { style: { flex: 1 } }),
					error ? h("span", { className: "dsh-bw-hero-error", role: "alert" }, error) : null,
					conflict ? h("button", { type: "button", className: "dsh-bw-btn", onClick: load }, t("files.reload")) : null,
					h("button", {
						type: "button", className: "dsh-bw-btn dsh-bw-btn-primary",
						disabled: !dirty || saving, onClick: save,
					}, saving ? t("files.saving") : t("files.save")),
					h("button", { type: "button", className: "dsh-bw-btn", onClick: props.onClose }, t("files.cancelEdit"))),
				h("textarea", {
					className: "dsh-bw-editor-area", value: text, spellCheck: false, "aria-label": props.path,
					onChange: (e) => setText(e.target.value),
					onKeyDown: (e) => {
						if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
							e.preventDefault();
							save();
						}
					},
				}));
		}

		function FileDiff({ file, wrap, anchorId, onEdit }) {
			const [open, setOpen] = useState(true);
			const bodyId = anchorId + "-body";
			return h("div", { className: "dsh-bw-file", id: anchorId },
				h("div", { className: "dsh-bw-filehead" },
					h("button", {
						type: "button", className: "dsh-bw-filetoggle", "aria-expanded": open,
						"aria-controls": bodyId, onClick: () => setOpen((o) => !o),
					},
						h("span", { className: "dsh-bw-caret", "aria-hidden": "true" }, open ? "▾" : "▸"),
						h(StatusLetter, { status: file.status }),
						h("span", { className: "dsh-bw-filepath", title: file.oldPath ? file.oldPath + " → " + file.path : file.path },
							file.oldPath ? file.oldPath + " → " + file.path : file.path),
						h("span", { className: "dsh-bw-filestat" },
							file.status === "binary" ? t("diff.binary")
								: file.status === "too_large" ? t("diff.tooLarge")
									: h(react.Fragment, null,
										h("span", { className: "dsh-bw-green" }, "+" + fmtNum(file.additions || 0)), " ",
										h("span", { className: "dsh-bw-red" }, "−" + fmtNum(file.deletions || 0))))),
					onEdit && file.status !== "binary" && file.status !== "too_large" && file.status !== "deleted"
						? h("button", {
							type: "button", className: "dsh-bw-btn dsh-bw-fileedit",
							onClick: () => onEdit(file.path),
						}, t("diff.editFile"))
						: null),
				h("div", { id: bodyId, hidden: !open },
					file.status === "binary" || file.status === "too_large"
						? h("div", { className: "dsh-bw-notice" }, file.status === "binary" ? t("diff.binaryBody") : t("diff.tooLargeBody"))
						: (file.hunks || []).map((hunk, index) => h(Hunk, { key: index, hunk, wrap }))));
		}

		function DiffView(props) {
			const sessionId = props.sessionId;
			const cwd = useCwd(sessionId);
			const agentRunning = useRunning(sessionId);
			return h(DiffViewResource, {
				...props, key: `${sessionId || ""}\u0000${cwd || ""}`, cwd, agentRunning,
			});
		}

		function DiffViewResource(props) {
			const sessionId = props.sessionId;
			// Keying the resource body by Session+cwd prevents a render from ever
			// pairing a new mutation target with the previous target's action state.
			const visible = props.visible !== false;
			const cwd = props.cwd;
			const agentRunning = props.agentRunning;
			const snapshot = useStore(feed.store, (s) => (cwd ? s.byCwd[cwd] : undefined));
			useEffect(() => {
				if (!cwd) return undefined;
				feed.track(cwd);
				return () => feed.untrack(cwd);
			}, [cwd]);


			const [mode, setMode] = useState("uncommitted");
			const [touched, setTouched] = useState(null);
			const [detectLite, setDetectLite] = useState(null);
			const [taskMissing, setTaskMissing] = useState(false);
			const [pane, setPane] = useState("files");
			const [diff, setDiff] = useState(null);
			const [commits, setCommits] = useState(null);
			const [selectedCommit, setSelectedCommit] = useState(null);
			const [actions, setActions] = useState(null);
			const [selectedFile, setSelectedFile] = useState(null);
			const [editingFile, setEditingFile] = useState(null);
			const [running, setRunning] = useState(null);
			const [banner, setBanner] = useState(null);
			const [ignoreWs, setIgnoreWs] = useState(false);
			const [wrap, setWrap] = useState(false);
			const [commitMsg, setCommitMsg] = useState("");
			const [rev, setRev] = useState(0);
			const lastAutoRefetch = useRef(0);
			const requestOwner = useRef(null);
			if (!requestOwner.current) requestOwner.current = createRequestOwner();
			const actionLock = useRef(false);
			const commitBackRef = useRef(null);
			const commitButtonRefs = useRef(new Map());
			const returnCommitFocus = useRef(null);
			useEffect(() => {
				if (selectedCommit && commitBackRef.current) commitBackRef.current.focus();
				else if (!selectedCommit && returnCommitFocus.current) {
					const target = commitButtonRefs.current.get(returnCommitFocus.current);
					returnCommitFocus.current = null;
					if (target) target.focus();
				}
			}, [selectedCommit]);
			useEffect(() => () => requestOwner.current.reset(), [cwd, sessionId]);
			// paseo-parity defaults: a managed worktree session's history IS the
			// task diff (base..worktree); a shared-workspace session falls back to
			// its own transcript-attributed files, then to plain uncommitted
			useEffect(() => {
				let alive = true;
				setDetectLite(null);
				setTouched(null);
				setTaskMissing(false);
				if (!cwd) return undefined;
				(async () => {
					let det;
					try { det = await apiGet("/detect" + qs({ path: cwd })); } catch { /* unavailable */ }
					if (!alive) return;
					if (det && det.ok) setDetectLite(det);
					// /detect answers managed=true exactly when worktree metadata
					// exists; the task route re-guards the base ref itself
					if (det && det.ok && det.isLinkedWorktree && det.managed) {
						setMode("task");
						return;
					}
					const paths = await sessionTouchedPaths(sessionId, cwd);
					if (!alive) return;
					setTouched(paths);
					setMode(paths && paths.size > 0 ? "session" : "uncommitted");
				})();
				return () => { alive = false; };
			}, [cwd, sessionId]);

			useEffect(() => {
				if (mode !== "session" || !cwd) return undefined;
				let alive = true;
				sessionTouchedPaths(sessionId, cwd, true).then((paths) => { if (alive) setTouched(paths); });
				return () => { alive = false; };
			}, [mode, rev, sessionId, cwd]);


			// auto refetch when the hub pushes a new snapshot revision (max 1 per 3s)
			const snapshotAt = snapshot ? snapshot.at : 0;
			useEffect(() => {
				if (!cwd || !visible) return;
				const now = Date.now();
				if (now - lastAutoRefetch.current < 3000) return;
				lastAutoRefetch.current = now;
				setRev((r) => r + 1);
			}, [snapshotAt, cwd, visible]);

			// coming back into view is a reason to refresh at once
			const wasVisible = useRef(visible);
			useEffect(() => {
				const previous = wasVisible.current;
				wasVisible.current = visible;
				if (!visible || previous) return;
				lastAutoRefetch.current = Date.now();
				setRev((r) => r + 1);
			}, [visible]);

			const load = useCallback(async () => {
				if (!cwd) return;
				const token = requestOwner.current.begin("diff-load");
				const commitSha = pane === "commits" && selectedCommit ? selectedCommit.sha : undefined;
				try {
					const [diffResult, actionsResult] = await Promise.all([
						apiGet("/diff" + qs({ cwd, mode, w: ignoreWs ? 1 : "", commit: commitSha }), token.controller.signal),
						apiGet("/actions" + qs({ cwd, running: agentRunning ? 1 : "" }), token.controller.signal),
					]);
					requireOwnership(requestOwner.current, token);
					let commitsResult = null;
					if ((mode === "base" || mode === "task") && pane === "commits" && !selectedCommit) {
						commitsResult = await apiGet("/commits" + qs({
							cwd,
							base: mode === "task" && diffResult && diffResult.ok ? diffResult.refs.baseRef : undefined,
						}), token.controller.signal);
						requireOwnership(requestOwner.current, token);
					}
					if (diffResult && diffResult.ok) setDiff(diffResult);
					else if (diffResult && diffResult.error === "task-base-missing") {
						setTaskMissing(true);
						setMode("uncommitted");
					}
					if (actionsResult && actionsResult.ok) setActions(actionsResult);
					if (commitsResult && commitsResult.ok) setCommits(commitsResult);
				} catch { /* transient, superseded, or hidden */ }
				finally { requestOwner.current.end(token); }
			}, [cwd, mode, pane, selectedCommit ? selectedCommit.sha : "", ignoreWs, agentRunning, rev]);

			useEffect(() => {
				setDiff(null);
				setEditingFile(null);
				load();
			}, [load]);

			function localizeFailure(result) {
				let text = result.reasonKey ? t(result.reasonKey, result.params || {}) : result.message || t("actions.failed");
				if (result.conflictFiles && result.conflictFiles.length > 0) text += ": " + result.conflictFiles.join(", ");
				if (result.recoveryCwd) text += " · " + t("actions.merge.recoveryCwd", { cwd: result.recoveryCwd });
				return text;
			}

			async function runAction(name, params, confirmText) {
				if (actionLock.current) return;
				if (confirmText && !window.confirm(confirmText)) return;
				const sourceId = sessionId;
				const archiveWorkspace = name === "archive" ? workspaceItems().find((item) => item.path === cwd) : null;
				const archiveSessionIds = archiveWorkspace && Array.isArray(archiveWorkspace.sessionIds)
					? archiveWorkspace.sessionIds.slice() : null;
				const archivedAtStart = new Set((workspaceSnapshot().archivedSessionIds || []).map(String));
				const archiveLiveSessionIds = archiveSessionIds
					? archiveSessionIds.map(String).filter((id) => !archivedAtStart.has(id)) : null;
				if (name === "archive" && (!archiveWorkspace || typeof archiveWorkspace.workspaceId !== "string"
					|| !archiveSessionIds || archiveLiveSessionIds.length !== 1 || archiveLiveSessionIds[0] !== sourceId
					|| !sessionsHaveEmptyDrafts(appCtx.sessions, archiveLiveSessionIds))) {
					setBanner({ kind: "err", text: t("actions.archive.draftBlocked") });
					return;
				}
				const releaseMutation = acquireWorkspaceMutation(cwd);
				if (!releaseMutation) return;
				actionLock.current = true;
				const archiveMainRoot = name === "archive" && snapshot ? snapshot.mainRepoRoot : null;
				const token = requestOwner.current.begin("action");
				const sagaLifecycleEpoch = activeLifecycleEpoch;
				const blockedArchiveIds = name === "archive" ? archiveLiveSessionIds : [];
				if (blockedArchiveIds.length > 0) {
					let conversation = null;
					try { conversation = appCtx.get("conversation"); } catch { /* unavailable */ }
					for (const blockedId of blockedArchiveIds) {
						workspaceArchiveBlocks.set(blockedId, token);
						try { if (conversation && conversation.blocks) conversation.blocks.set(blockedId, { reason: t("actions.archive.confirm") }); } catch { /* cosmetic */ }
					}
				}
				setRunning(name);
				setBanner(null);
				try {
					if (name === "archive" && !sessionsHaveEmptyDrafts(appCtx.sessions, blockedArchiveIds)) {
						throw new Error(t("actions.archive.draftBlocked"));
					}
					const requestParams = name === "archive"
						? { ...(params || {}), deferWorkspaceDelete: true }
						: params || {};
					let result = await apiPost("/action", { cwd, name, params: requestParams });
					if (!(name === "archive" && result && result.ok)) requireOwnership(requestOwner.current, token);
					if (result && !result.ok && name === "archive" && result.reason === "unsafe") {
						const forced = window.confirm(t("actions.archive.unsafeConfirm", { message: result.message || "" }));
						if (forced) result = await apiPost("/action", { cwd, name, params: { ...requestParams, force: true } });
						requireOwnership(requestOwner.current, token);
					}
					if (result && result.ok) {
						if (name === "archive") {
							if (activeLifecycleEpoch !== sagaLifecycleEpoch
								|| workspaceArchiveBlocks.get(sourceId) !== token) return;
							if (!archiveMainRoot || result.workspaceId !== archiveWorkspace.workspaceId
								|| !Array.isArray(result.workspaceSessionIds)) {
								throw new Error("archive Workspace receipt is incomplete");
							}
							const authoritativeSessionIds = result.workspaceSessionIds.map(String);
							const archivedNow = new Set((workspaceSnapshot().archivedSessionIds || []).map(String));
							const authoritativeLiveIds = authoritativeSessionIds.filter((id) => !archivedNow.has(id));
							if (authoritativeLiveIds.length > 0 && (authoritativeLiveIds.length !== 1
								|| authoritativeLiveIds[0] !== sourceId
								|| !sessionsHaveEmptyDrafts(appCtx.sessions, authoritativeLiveIds))) {
								throw new Error(t("actions.archive.draftBlocked"));
							}
							const settledCurrent = currentSessionId();
							if (settledCurrent === sourceId) await openWorkspaceFor(archiveMainRoot, sourceId);
							if (activeLifecycleEpoch !== sagaLifecycleEpoch
								|| workspaceArchiveBlocks.get(sourceId) !== token
								|| !sessionsHaveEmptyDrafts(appCtx.sessions, authoritativeLiveIds)) return;
							for (const archivedId of authoritativeLiveIds) {
								if (activeLifecycleEpoch !== sagaLifecycleEpoch
									|| workspaceArchiveBlocks.get(sourceId) !== token) return;
								await appCtx.workspaces.archiveSession(archivedId);
							}
							if (activeLifecycleEpoch !== sagaLifecycleEpoch
								|| workspaceArchiveBlocks.get(sourceId) !== token) return;
							if (result.workspaceDeletionToken) {
								const finalized = await apiPost("/worktrees/finalize-delete", {
									cwd: archiveMainRoot,
									token: result.workspaceDeletionToken,
								});
								if (!finalized || !finalized.ok) throw new Error(failureMessage(finalized) || "workspace deletion finalization failed");
							}
							return;
						}
						setBanner({ kind: "ok", text: t("actions." + name + ".done") + (result.url ? " · " + result.url : "") });
						if (name === "commit") setCommitMsg("");
						lastAutoRefetch.current = Date.now();
						feed.refresh(cwd);
						setRev((r) => r + 1);
					} else setBanner({ kind: "err", text: localizeFailure(result || {}) });
				} catch (e) {
					if (requestOwner.current.owns(token)) setBanner({ kind: "err", text: String((e && e.message) || e) });
				} finally {
					if (requestOwner.current.owns(token)) setRunning(null);
					requestOwner.current.end(token);
					clearArchiveBlocks(blockedArchiveIds, token);
					actionLock.current = false;
					releaseMutation();
				}
			}

			if (!cwd) return h("div", { className: "dsh-bw-view" }, h("div", { className: "dsh-bw-empty" }, t("diff.loading")));
			if (snapshot && snapshot.isGit === false) {
				return h("div", { className: "dsh-bw-view" }, h("div", { className: "dsh-bw-empty" }, t("diff.notGit")));
			}

			// Core Workspace/Agent services currently expose no cross-page retiring
			// lease. Hide manual physical archive rather than race another page's
			// draft or Agent admission; Host independently fails closed as well.
			const ladder = ((actions && actions.ladder) || []).filter((entry) => entry.id !== "archive");
			const pr = snapshot ? snapshot.pr : null;
			const sync = snapshot ? syncOf(snapshot) : { ahead: 0, behind: 0 };
			const enabled = ladder.filter((entry) => !entry.disabled && entry.id !== "openPr");
			const primary = enabled.length > 0 ? enabled[0] : null;
			const rest = ladder.filter((entry) => entry !== primary && entry.id !== "openPr");

			function onPrimary() {
				if (!primary) return;
				if (primary.id === "commit") {
					if (!commitMsg.trim()) { setBanner({ kind: "err", text: t("actions.commit.noMessage") }); return; }
					runAction("commit", { message: commitMsg.trim(), addAll: true });
					return;
				}
				if (primary.id === "discard") { runAction("discard", {}, t("actions.discard.confirm")); return; }
				if (primary.id === "archive") { runAction("archive", { path: cwd }, t("actions.archive.confirm")); return; }
				runAction(primary.id, {});
			}

			function onMenuAction(id) {
				if (id === "commit") {
					if (!commitMsg.trim()) { setBanner({ kind: "err", text: t("actions.commit.noMessage") }); return; }
					runAction("commit", { message: commitMsg.trim(), addAll: true });
					return;
				}
				if (id === "discard") { runAction("discard", {}, t("actions.discard.confirm")); return; }
				if (id === "archive") { runAction("archive", { path: cwd }, t("actions.archive.confirm")); return; }
				runAction(id, {});
			}

			const toolbar = h("div", { className: "dsh-bw-toolbar" },
				h("div", { className: "dsh-bw-seg" },
					h("button", { type: "button", "aria-pressed": mode === "uncommitted", onClick: () => { setMode("uncommitted"); setSelectedCommit(null); } }, t("diff.modeUncommitted")),
					h("button", {
						type: "button", "aria-pressed": mode === "session",
						disabled: touched !== null && touched.size === 0,
						title: touched === null ? t("diff.sessionUnavailable") : touched && touched.size === 0 ? t("diff.sessionEmpty") : undefined,
						onClick: () => { setMode("session"); setSelectedCommit(null); },
					}, t("diff.modeSession")),
					detectLite && detectLite.isLinkedWorktree && detectLite.managed
						? h("button", { type: "button", "aria-pressed": mode === "task", onClick: () => { setMode("task"); setSelectedCommit(null); } }, t("diff.modeTask"))
						: null,
					h("button", { type: "button", "aria-pressed": mode === "base", onClick: () => { setMode("base"); setSelectedCommit(null); } }, t("diff.modeBase"))),
				snapshot && snapshot.branch
					? h("span", { className: "dsh-bw-branch" }, "⎇", h("span", { className: "dsh-bw-branch-name", title: snapshot.branch }, snapshot.branch),
						snapshot.baseRefName && snapshot.baseRefName !== snapshot.branch ? h("span", { className: "dsh-bw-menu-hint" }, "← " + snapshot.baseRefName) : null)
					: null,
				snapshot && (sync.ahead > 0 || sync.behind > 0)
					? h("span", { className: "dsh-bw-sync" }, (sync.ahead > 0 ? "↑" + sync.ahead : "") + (sync.ahead > 0 && sync.behind > 0 ? " " : "") + (sync.behind > 0 ? "↓" + sync.behind : ""))
					: null,
				pr && pr.number
					? h("span", { className: "dsh-bw-pr" },
						h(PrNumBadge, { pr }),
						h("span", { className: "dsh-bw-pr-title", title: pr.title }, pr.title),
						pr.isDraft ? h("span", { className: "dsh-bw-menu-hint" }, t("diff.prDraft")) : null,
						pr.checks && pr.checks.status !== "none" ? h(ChecksRing, { checks: pr.checks }) : null,
						pr.mergeable === "CONFLICTING" ? h("span", { className: "dsh-bw-red" }, t("diff.prConflicting")) : null,
						pr.url ? h("a", { href: pr.url, target: "_blank", rel: "noreferrer" }, t("diff.openPr")) : null)
					: null,
				h("span", { className: "dsh-bw-toolbar-spacer" }),
				h("label", { className: "dsh-bw-check" },
					h("input", { type: "checkbox", checked: ignoreWs, onChange: (e) => setIgnoreWs(e.target.checked) }),
					t("diff.ignoreWs")),
				h("label", { className: "dsh-bw-check" },
					h("input", { type: "checkbox", checked: wrap, onChange: (e) => setWrap(e.target.checked) }),
					t("diff.wrap")),
				h("button", { type: "button", className: "dsh-bw-btn", onClick: () => { feed.refresh(cwd); setRev((r) => r + 1); }, disabled: Boolean(running) }, t("diff.refresh")),
				primary
					? h("button", {
						type: "button", className: cx("dsh-bw-btn", "dsh-bw-btn-primary", primary.id === "discard" && "dsh-bw-btn-danger"),
						onClick: onPrimary, disabled: Boolean(running),
					}, t("actions." + primary.id) + (primary.id === "push" && primary.params && primary.params.ahead ? " (" + primary.params.ahead + ")" : "") + (primary.id === "pull" && primary.params && primary.params.behind ? " (" + primary.params.behind + ")" : ""))
					: null,
				rest.length > 0
					? h(Popover, {
						align: "right",
						trigger: ({ toggle, open }) => h("button", { type: "button", className: "dsh-bw-btn", onClick: toggle, "aria-expanded": open }, t("actions.more"), " ▾"),
						children: (close) => h(MenuList, {
							items: rest.map((entry) => ({
								id: entry.id,
								label: t("actions." + entry.id),
								disabled: Boolean(entry.disabled) || Boolean(running),
								reason: entry.reasonKey ? t(entry.reasonKey, entry.params || {}) : running ? t("actions.disabled.agentRunning") : null,
								hint: entry.warn ? "!" : null,
							})),
							onSelect: (id) => { close(); onMenuAction(id); },
						}),
					})
					: null);

			const commitKnown = snapshotMutationKnown(snapshot);
			const commitRow = mode === "uncommitted" && snapshot && commitKnown && snapshot.dirty
				? h("div", { className: "dsh-bw-commitrow" },
					h("input", {
						type: "text", className: "dsh-bw-commit-input", value: commitMsg, placeholder: t("diff.commitPlaceholder"), "aria-label": t("diff.commitPlaceholder"),
						onChange: (e) => setCommitMsg(e.target.value),
						onKeyDown: (e) => {
							if (e.key === "Enter" && commitMsg.trim() && !running) {
								runAction("commit", { message: commitMsg.trim(), addAll: true });
							}
						},
						disabled: Boolean(running),
					}),
					h("button", {
						type: "button", className: "dsh-bw-btn dsh-bw-btn-primary", disabled: Boolean(running) || !commitMsg.trim(),
						onClick: () => runAction("commit", { message: commitMsg.trim(), addAll: true }),
					}, t("diff.commitAll")))
				: null;

			const bannerEl = banner
				? h("div", { className: cx("dsh-bw-banner", banner.kind === "ok" ? "dsh-bw-banner-ok" : "dsh-bw-banner-err"), role: banner.kind === "ok" ? "status" : "alert" }, banner.text)
				: null;
			const taskBanner = taskMissing
				? h("div", { className: "dsh-bw-banner dsh-bw-banner-err", role: "alert" }, t("diff.taskUnavailable"))
				: null;

			const allFiles = (diff && diff.files) || [];
			const files = mode === "session" && touched ? allFiles.filter((f) => touched.has(f.path)) : allFiles;
			const showCommitToggle = mode === "base" || mode === "task";
			const fileList = h("div", { className: "dsh-bw-filelist" },
				showCommitToggle
					? h("div", { className: "dsh-bw-seg", style: { margin: "8px 10px" } },
						h("button", { type: "button", "aria-pressed": pane === "files", onClick: () => { setPane("files"); setSelectedCommit(null); } }, t("diff.paneFiles")),
						h("button", { type: "button", "aria-pressed": pane === "commits", onClick: () => setPane("commits") }, t("diff.paneCommits")))
					: null,
				pane === "files" || selectedCommit
					? files.length === 0
						? h("div", { className: "dsh-bw-empty", role: diff ? undefined : "status", "aria-live": diff ? undefined : "polite" }, mode === "session" && touched && touched.size === 0 ? t("diff.sessionEmpty") : diff ? t("diff.empty") : t("diff.loading"))
						: files.map((file, index) =>
							h("button", {
								key: file.path, type: "button", "aria-current": selectedFile === file.path ? "true" : undefined,
								className: cx("dsh-bw-fileitem", selectedFile === file.path && "dsh-bw-fileitem-active"),
								onClick: () => {
									setSelectedFile(file.path);
									const anchor = document.getElementById("dsh-bw-f-" + index);
									if (anchor) anchor.scrollIntoView({ block: "start" });
								},
							},
								h(StatusLetter, { status: file.status }),
								h("span", { className: "dsh-bw-fileitem-path", title: file.path }, file.path),
								h("span", { className: "dsh-bw-fileitem-stat" },
									file.status === "binary" || file.status === "too_large"
										? ""
										: h(react.Fragment, null,
											h("span", { className: "dsh-bw-green" }, "+" + fmtNum(file.additions || 0)), " ",
											h("span", { className: "dsh-bw-red" }, "−" + fmtNum(file.deletions || 0))))))
					: h("div", { className: "dsh-bw-commits", style: { maxHeight: "none", flex: 1 } },
						!commits
							? h("div", { className: "dsh-bw-empty", role: "status", "aria-live": "polite" }, t("diff.loading"))
							: commits.commits.length === 0
								? h("div", { className: "dsh-bw-empty" }, t("diff.commitListEmpty"))
								: commits.commits.map((commit) =>
									h("button", {
										key: commit.sha, type: "button", "aria-pressed": Boolean(selectedCommit && selectedCommit.sha === commit.sha),
										ref: (node) => { if (node) commitButtonRefs.current.set(commit.sha, node); else commitButtonRefs.current.delete(commit.sha); },
										className: cx("dsh-bw-commit", selectedCommit && selectedCommit.sha === commit.sha && "dsh-bw-commit-active"),
										onClick: () => setSelectedCommit(commit),
									},
										h("span", { className: "dsh-bw-sha" }, commit.short),
										h("span", { className: "dsh-bw-commit-subject", title: commit.subject }, commit.subject),
										commit.unpushed ? h("span", { className: "dsh-bw-unpushed-dot", title: t("diff.unpushed") }, "↑") : null,
										h("span", { className: "dsh-bw-commit-meta" }, fmtRelTime(commit.at, lang()))))));

			const diffPane = h("div", { className: "dsh-bw-diffpane" },
				selectedCommit
					? h("div", { className: "dsh-bw-toolbar" },
						h("button", {
							ref: commitBackRef, type: "button", className: "dsh-bw-btn",
							onClick: () => { returnCommitFocus.current = selectedCommit.sha; setSelectedCommit(null); },
						}, t("diff.backToBranch")),
						h("span", { className: "dsh-bw-sha" }, selectedCommit.short),
						h("span", { className: "dsh-bw-commit-subject" }, selectedCommit.subject))
					: null,
				diff && diff.tooLarge ? h("div", { className: "dsh-bw-banner dsh-bw-banner-err" }, t("diff.truncated")) : null,
				files.length === 0
					? h("div", { className: "dsh-bw-empty" }, diff ? t("diff.empty") : t("diff.loading"))
					: files.map((file, index) => h(FileDiff, {
						key: (selectedCommit ? selectedCommit.sha : mode) + ":" + file.path,
						file, wrap, anchorId: "dsh-bw-f-" + index,
						onEdit: (path) => setEditingFile(path),
					})));

			return h("div", { className: "dsh-bw-view" },
				toolbar,
				bannerEl,
				taskBanner,
				commitRow,
				h("div", { className: "dsh-bw-body" }, fileList,
					editingFile
						? h(FileEditor, {
							key: cwd + "\u0000" + editingFile,
							cwd,
							path: editingFile,
							onSaved: () => { load(); },
							onClose: () => { setEditingFile(null); load(); },
						})
						: diffPane));
		}

		/* ================================================================ */
		/* official right-Sidebar page                                       */
		/* ================================================================ */

		/**
		 * This page type's identity in the tab system, and the key its body and
		 * chip title register under in `sidebar.right.pane.tab` /
		 * `sidebar.right.pane.tab.title`.
		 */
		const SIDEBAR_DIFF_ID = "dsh-better-workspaces/diff";
		/** Type discriminator; `ctx.sidebarRight.openTab` names it. */
		const SIDEBAR_DIFF_KIND = "bw-diff";

		/**
		 * The chip's glyph: a page with one added and one removed line — the
		 * plugin's own ± motif, drawn at DSH's 16px `currentColor` stroke weight
		 * so no extra runtime dependency is needed for one small icon.
		 * @param props - rendered size and class.
		 * @returns the glyph.
		 */
		function DiffGlyph({ size, className }) {
			const edge = size || 16;
			return h("svg", {
				viewBox: "0 0 16 16", width: edge, height: edge, className,
				fill: "none", stroke: "currentColor", strokeWidth: 1.25,
				strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
			},
				h("path", { d: "M3.5 2.25h5.75L12.5 5.5v8.25h-9z" }),
				h("path", { d: "M9.25 2.25V5.5h3.25" }),
				h("path", { d: "M6 8h4" }),
				h("path", { d: "M8 6v4" }),
				h("path", { d: "M6 11.5h4" }));
		}

		/**
		 * The diff page's registry definition: a page type (no resource address),
		 * offered the same way the official files panel offers itself.
		 *
		 * The `guide` entry is what puts a 代码变更 capsule beside the official
		 * 工作区文件 one on the sidebar's 开始 page (and behind its `+` control);
		 * the composer pill stays the one-click door. Declaring it costs the
		 * `defaultSeed` shortcut: the seed lands on a type directly only while
		 * exactly ONE guide entry exists, so a session whose right column has no
		 * stored layout now opens on 开始 (the chooser) instead of jumping into
		 * 工作区文件 — the trade-off recorded in ADR 0006 Amendment 1, which
		 * supersedes this definition's earlier deliberate no.
		 * @returns the definition to register.
		 */
		function sidebarDiffDefinition() {
			return {
				id: SIDEBAR_DIFF_ID,
				kind: SIDEBAR_DIFF_KIND,
				priority: "extension",
				title: () => t("view.diff"),
				guide: [{
					order: 20,
					title: () => t("guide.title"),
					description: () => t("guide.description"),
					icon: DiffGlyph,
				}],
			};
		}

		/** The diff page's body: the shared DiffView, aware of whether its tab is showing. */
		function SidebarDiffBody(props) {
			const info = props.useTabInfo();
			return h("div", { className: "dsh-bw-sb" },
				h(DiffView, { key: props.sessionId, sessionId: props.sessionId, visible: info.tab.visible }));
		}

		/** The diff chip: the glyph before the tab's captured title. */
		function SidebarDiffTitle({ useTabInfo }) {
			const { tab } = useTabInfo();
			return h(react.Fragment, null,
				h(DiffGlyph, { size: 16, className: "dsh-bw-tabicon" }),
				tab.title);
		}

		/* ================================================================ */
		/* composer forge control (issue / PR reference)                     */
		/* ================================================================ */

		/* The reference source's name IS the serializer routing key the
		 * conversation stores on every chip ("slash: no serializer for
		 * reference source X" is the failure when it goes missing), so it must
		 * stay registered for as long as this plugin is mounted — a chip
		 * inserted by the picker would otherwise block the send. */
		const FORGE_SOURCE = "better-workspaces-forge";
		/** List rows are display hints only; submit always refreshes exact detail. */
		const forgeItems = new Map();
		/** Successfully attached canonical refs, scoped by owning Session ID. */
		const forgeAttached = new Map();
		const forgeDraftRehydration = new Map();
		const forgeDraftBlocks = new Map();
		const FORGE_REF_PREFIX = "bw1";
		const FORGE_DRAFT_KEY_PREFIX = "dsh-bw-forge-draft-v1:";

		function scalarToHex(value) {
			let hex = "";
			for (let i = 0; i < value.length; i += 1) hex += value.charCodeAt(i).toString(16).padStart(4, "0");
			return hex;
		}

		function hexToScalar(hex) {
			if (typeof hex !== "string" || hex.length % 4 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
			let value = "";
			for (let i = 0; i < hex.length; i += 4) value += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
			return value;
		}

		function encodeForgeRef(item) {
			if (!item || !Number.isSafeInteger(item.number) || item.number <= 0
				|| !["issue", "change_request"].includes(item.kind)
				|| !item.host || !item.owner || !item.repo) return null;
			const json = JSON.stringify([String(item.host).toLowerCase(), String(item.owner).toLowerCase(), String(item.repo).toLowerCase(), item.kind, item.number]);
			let hex = "";
			for (let i = 0; i < json.length; i += 1) hex += json.charCodeAt(i).toString(16).padStart(4, "0");
			return FORGE_REF_PREFIX + hex;
		}

		function decodeForgeRef(ref) {
			if (typeof ref !== "string") return null;
			if (/^[1-9]\d*$/.test(ref)) {
				const number = Number(ref);
				return Number.isSafeInteger(number) ? { version: 0, number } : null;
			}
			if (!ref.startsWith(FORGE_REF_PREFIX) || (ref.length - FORGE_REF_PREFIX.length) % 4 !== 0) return null;
			try {
				let json = "";
				for (let i = FORGE_REF_PREFIX.length; i < ref.length; i += 4) json += String.fromCharCode(Number.parseInt(ref.slice(i, i + 4), 16));
				const value = JSON.parse(json);
				if (!Array.isArray(value) || value.length !== 5) return null;
				const [host, owner, repo, kind, number] = value;
				if (!host || !owner || !repo || !["issue", "change_request"].includes(kind)
					|| !Number.isSafeInteger(number) || number <= 0) return null;
				return { version: 1, host: String(host).toLowerCase(), owner: String(owner).toLowerCase(), repo: String(repo).toLowerCase(), kind, number };
			} catch {
				return null;
			}
		}

		function invalidForgeClipboardText(ref) {
			if (typeof ref !== "string" || !ref.startsWith("bwi")) return null;
			return hexToScalar(ref.slice(3));
		}

		function forgeClipboardText(ref) {
			const invalid = invalidForgeClipboardText(ref);
			if (invalid !== null) return invalid;
			const identity = decodeForgeRef(ref);
			if (!identity) return "#?";
			if (identity.version === 0) return "#" + identity.number;
			const route = identity.kind === "change_request" ? "pull" : "issues";
			return `[[dsh-bw1:https://${identity.host}/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}/${route}/${identity.number}]]`;
		}

		function embeddedForgeDraft(draft) {
			if (typeof draft !== "string") return null;
			const references = [];
			const token = /\[\[dsh-bw1:https:\/\/([a-z0-9.-]+(?::\d+)?)\/([^/\s\]]+)\/([^/\s\]]+)\/(pull|issues)\/([1-9]\d*)\]\]/gi;
			let residual = draft;
			let match;
			while ((match = token.exec(draft)) !== null) {
				let owner;
				let repo;
				try { owner = decodeURIComponent(match[2]); repo = decodeURIComponent(match[3]); } catch { return { invalid: true, draft, references: [] }; }
				const identity = {
					version: 1, host: match[1].toLowerCase(), owner, repo,
					kind: match[4] === "pull" ? "change_request" : "issue", number: Number(match[5]),
				};
				const ref = encodeForgeRef(identity);
				if (!ref) return { invalid: true, draft, references: [] };
				references.push({
					ref, offset: match.index, length: match[0].length,
					label: (identity.kind === "change_request" ? "PR #" : "Issue #") + identity.number,
					clipboardText: match[0],
				});
				residual = residual.slice(0, match.index) + " ".repeat(match[0].length) + residual.slice(match.index + match[0].length);
			}
			const malformed = /\[\[dsh-bw1:[^\s\]]*(?:\]\])?/i.exec(residual);
			if (malformed) {
				references.push({
					ref: "bwi" + scalarToHex(malformed[0]), offset: malformed.index, length: malformed[0].length,
					label: t("forge.invalid"), clipboardText: malformed[0], invalid: true,
				});
				references.sort((a, b) => a.offset - b.offset);
				return { version: 1, invalid: true, draft, references };
			}
			return references.length ? { version: 1, draft, references } : null;
		}

		function forgeItemKey(item) {
			return encodeForgeRef(item);
		}

		function cacheForgeItem(ref, item) {
			forgeItems.delete(ref);
			forgeItems.set(ref, item);
			while (forgeItems.size > 512) forgeItems.delete(forgeItems.keys().next().value);
		}

		function rememberForgeItem(item, sessionId) {
			const ref = forgeItemKey(item);
			if (!ref || typeof sessionId !== "string" || sessionId === "") return;
			cacheForgeItem(ref, item);
			const attached = forgeAttached.get(sessionId) || new Set();
			attached.add(ref);
			while (attached.size > 512) attached.delete(attached.values().next().value);
			forgeAttached.set(sessionId, attached);
			while (forgeAttached.size > 512) forgeAttached.delete(forgeAttached.keys().next().value);
		}

		function forgeDraftStorageKey(sessionId) {
			return FORGE_DRAFT_KEY_PREFIX + sessionId;
		}

		function setForgeDraftBlock(sessionId, blocked) {
			let conversation = null;
			try { conversation = appCtx && appCtx.get("conversation"); } catch { /* unavailable */ }
			if (!conversation || !conversation.blocks || !sessionId) return;
			const owned = forgeDraftBlocks.get(sessionId);
			let current;
			try { current = conversation.blocks.storeFor(sessionId).getSnapshot(); } catch { current = undefined; }
			if (blocked) {
				if (owned && current === owned) return;
				if (owned) forgeDraftBlocks.delete(sessionId);
				if (current !== undefined) return;
				const block = { reason: t("forge.restorePending") };
				conversation.blocks.set(sessionId, block);
				forgeDraftBlocks.set(sessionId, block);
				return;
			}
			if (!owned) return;
			if (current === owned) conversation.blocks.set(sessionId, undefined);
			forgeDraftBlocks.delete(sessionId);
		}

		function readForgeDraftSidecar(sessionId) {
			try {
				const parsed = JSON.parse(localStorage.getItem(forgeDraftStorageKey(sessionId)) || "null");
				if (!parsed || parsed.version !== 1 || typeof parsed.draft !== "string" || !Array.isArray(parsed.references)) return null;
				let end = 0;
				const references = [];
				for (const entry of parsed.references) {
					const identity = decodeForgeRef(entry && entry.ref);
					const invalidProjection = invalidForgeClipboardText(entry && entry.ref);
					const ownedRef = Boolean(identity?.version === 1 || invalidProjection !== null);
					const entryEnd = entry && entry.offset + entry.length;
					if (!ownedRef || !Number.isSafeInteger(entry.offset)
						|| !Number.isSafeInteger(entry.length) || entry.length < 2 || entry.offset < end
						|| !Number.isSafeInteger(entryEnd) || entryEnd > parsed.draft.length
						|| typeof entry.label !== "string" || entry.label.length > 500
						|| entry.clipboardText !== forgeClipboardText(entry.ref) || entry.length !== entry.clipboardText.length
						|| parsed.draft.slice(entry.offset, entryEnd) !== entry.clipboardText) return null;
					end = entry.offset + entry.length;
					references.push({
						ref: entry.ref, offset: entry.offset, length: entry.length,
						label: entry.label, clipboardText: entry.clipboardText,
						invalid: invalidProjection !== null,
					});
				}
				return references.length ? { version: 1, draft: parsed.draft, references } : null;
			} catch {
				return null;
			}
		}

		function writeForgeDraftSidecar(sessionId, input) {
			try {
				const references = (input.occurrences || [])
					.filter((entry) => entry && entry.source === FORGE_SOURCE
						&& (decodeForgeRef(entry.ref)?.version === 1 || invalidForgeClipboardText(entry.ref) !== null))
					.map((entry) => ({
						ref: entry.ref, offset: entry.offset, length: entry.length,
						label: entry.label, clipboardText: entry.clipboardText,
					}));
				if (!references.length) {
					localStorage.removeItem(forgeDraftStorageKey(sessionId));
					return;
				}
				localStorage.setItem(forgeDraftStorageKey(sessionId), JSON.stringify({ version: 1, draft: input.draft, references }));
			} catch { /* unavailable/full storage never changes the live draft */ }
		}

		function settleForgeDraftSidecar(sessionId, input, sessionInput) {
			const current = inputSnapshot(sessionInput) || input;
			if (!sessionId || !current || typeof current.draft !== "string") return false;
			let pending = forgeDraftRehydration.get(sessionId) || null;
			const allOccurrences = (current.occurrences || []).filter((entry) => entry && Number.isSafeInteger(entry.offset) && Number.isSafeInteger(entry.length));
			const live = allOccurrences.filter((entry) => entry.source === FORGE_SOURCE);
			if (!pending) {
				const saved = readForgeDraftSidecar(sessionId);
				const embedded = embeddedForgeDraft(current.draft);
				let stored = embedded || (saved && saved.draft === current.draft ? saved : null);
				if (!stored) {
					if (live.length) writeForgeDraftSidecar(sessionId, current);
					return false;
				}
				if (embedded && saved && saved.draft === current.draft) {
					const labels = new Map(saved.references.map((entry) => [`${entry.offset}\u0000${entry.ref}`, entry.label]));
					stored = {
						...embedded,
						references: embedded.references.map((entry) => ({
							...entry, label: labels.get(`${entry.offset}\u0000${entry.ref}`) || entry.label,
						})),
					};
				}
				const claimed = new Set();
				const remaining = stored.references.filter((entry) => {
					const index = live.findIndex((occurrence, liveIndex) => !claimed.has(liveIndex)
						&& occurrence.offset === entry.offset && occurrence.ref === entry.ref);
					if (index < 0) return true;
					claimed.add(index);
					return false;
				});
				pending = { ...stored, remaining: remaining.reverse() };
				if (!pending.remaining.length) {
					writeForgeDraftSidecar(sessionId, current);
					return false;
				}
				forgeDraftRehydration.set(sessionId, pending);
			}
			if (pending.draft !== current.draft) {
				forgeDraftRehydration.delete(sessionId);
				try { localStorage.removeItem(forgeDraftStorageKey(sessionId)); } catch { /* unavailable */ }
				return false;
			}
			const missing = pending.remaining[0];
			if (!missing) {
				forgeDraftRehydration.delete(sessionId);
				writeForgeDraftSidecar(sessionId, current);
				return false;
			}
			if (!sessionInput || typeof sessionInput.insertReference !== "function") return false;
			let shrink = 0;
			for (const entry of allOccurrences) if (entry.offset < missing.offset) shrink += entry.length - 1;
			const start = missing.offset - shrink;
			const rev = current.draftRev;
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(rev)) return false;
			const inserted = sessionInput.insertReference({
				source: FORGE_SOURCE,
				ref: missing.ref,
				label: missing.label,
				clipboardText: missing.clipboardText,
			}, { start, end: start + missing.length, draftRev: rev }) === true;
			if (!inserted) return false;
			pending.remaining.shift();
			const after = inputSnapshot(sessionInput);
			if (after && typeof after.draft === "string") pending.draft = after.draft;
			return true;
		}

		/**
		 * Is the opt-in diagnostics channel on? Enabled from the page console with
		 * `localStorage.setItem("dsh-bw-debug", "1")`; absent storage (Node, a
		 * sandboxed frame) answers "off" rather than throwing.
		 * @returns whether traces should be emitted.
		 */
		function forgeDebugOn() {
			try {
				return typeof localStorage !== "undefined" && localStorage.getItem("dsh-bw-debug") === "1";
			} catch {
				return false;
			}
		}

		/**
		 * Emit one step of the pick path. Every failure between a row click and a
		 * chip on screen is otherwise silent — `insertReference` answers `false`
		 * instead of throwing, `setDraft` returns without a write when the draft is
		 * unchanged, and the resolver swallows its own exceptions — so this
		 * channel is what makes a report actionable. Zero cost when off.
		 * @param step - short stage name.
		 * @param detail - plain data describing that stage (never live objects).
		 */
		function forgeTrace(step, detail) {
			if (!forgeDebugOn()) return;
			try {
				console.warn("[better-workspaces:forge]", step, detail);
			} catch { /* a diagnostics channel must never break the feature */ }
		}

		function forgeItemLabel(item) {
			const prefix = item.kind === "change_request" ? "PR" : "Issue";
			return prefix + " #" + item.number + (item.title ? " " + item.title : "");
		}

		/**
		 * Resolve the composer facade that owns one session's editor.
		 *
		 * `conversation.input.for(actx)` resolves its session through
		 * `sessions.scopeOf(ctx)` — a PRIVATE tag the sessions service stamps on
		 * the ctx it materializes per session. A session BINDING carries no such
		 * tag, so handing one over throws ("conversation.input.for requires a
		 * session scope"); `sessions.scope(id)` is the public accessor for the ctx
		 * it wants. Returns null when any hop is missing, so the caller can fall
		 * back to a plain-text write instead of failing silently.
		 * @param sessions - the client sessions service.
		 * @param sessionId - the session whose composer receives the reference.
		 * @returns the session's input facade, or null.
		 */
		function resolveForgeSessionInput(sessions, sessionId) {
			try {
				/* The service key is "conversation", NOT "uiConversation": the official
				   plugin registers two different classes and only this one carries the
				   SessionInputResolver (`super(ctx, "conversation")` + `this.input =
				   config.input`; the `uiConversation` class has no `input` member at
				   all). `uiConversation` is merely the local variable name the official
				   bundle happens to use in its own apply, so `get("uiConversation")`
				   answered undefined and every attach was skipped before it could even
				   try — a silent no-op on a key that never existed. */
				const scope = sessions && sessions.scope ? sessions.scope(sessionId) : undefined;
				const scopedConversation = scope && typeof scope.get === "function" ? scope.get("conversation") : null;
				const rootConversation = appCtx && appCtx.get ? appCtx.get("conversation") : null;
				const conversation = scopedConversation || rootConversation;
				forgeTrace("resolve", {
					sessionId: String(sessionId),
					hasConversation: Boolean(conversation),
					hasInput: Boolean(conversation && conversation.input),
					hasScope: Boolean(scope),
					hasFor: Boolean(conversation && conversation.input && typeof conversation.input.for === "function"),
				});
				const shell = resolveSessionInput(sessions, sessionId);
				forgeTrace("resolve.shell", {
					gotShell: Boolean(shell),
					hasInsertReference: Boolean(shell && typeof shell.insertReference === "function"),
					hasCaretSpan: Boolean(shell && typeof shell.caretSpan === "function"),
					hasSetDraft: Boolean(shell && typeof shell.setDraft === "function"),
					hasNotify: Boolean(shell && typeof shell.notify === "function"),
					shellRev: shell && typeof shell.rev === "number" ? shell.rev : null,
				});
				return shell;
			} catch (error) {
				forgeTrace("resolve.threw", { message: String((error && error.message) || error) });
				return null;
			}
		}

		/**
		 * Convert a published InputState's clipboard projection to its exact detect
		 * end. Occurrence offset/length are BOTH clipboard coordinates. The editor
		 * projects every real chip as one U+FFFC in detect text, so each occurrence
		 * shrinks by `length - 1`; ordinary text, line breaks and block gaps keep the
		 * same length in both projections.
		 *
		 * Malformed ranges return null rather than manufacturing a span: an invalid
		 * detect span makes `insertReference` answer false and used to trigger the
		 * surprising full-text fallback.
		 * @param input - published InputState (live shell snapshot preferred).
		 * @returns the detect-coordinate document end, or null when inconsistent.
		 */
		function referenceDetectEnd(input) {
			if (!input || typeof input.draft !== "string" || !Array.isArray(input.occurrences)) return null;
			let previousEnd = 0;
			let shrink = 0;
			for (const occurrence of input.occurrences) {
				const offset = occurrence && occurrence.offset;
				const length = occurrence && occurrence.length;
				if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 1) return null;
				const clipboardEnd = offset + length;
				if (!Number.isSafeInteger(clipboardEnd) || offset < previousEnd || clipboardEnd > input.draft.length) return null;
				previousEnd = clipboardEnd;
				shrink += length - 1;
				if (!Number.isSafeInteger(shrink)) return null;
			}
			const end = input.draft.length - shrink;
			return Number.isSafeInteger(end) && end >= 0 ? end : null;
		}

		/**
		 * Pick an append-only insertion span from the LIVE shell. `caretSpan()` may
		 * answer a selection parked in the middle of text; a dialog pick must not
		 * split it, so only a collapsed caret exactly at the computed detect end is
		 * reused. The revision always comes from the shell counter checked by the
		 * official span CAS. Render-time input is a last-resort compatibility
		 * fallback, never preferred over `target.snapshot`.
		 * @param target - the resolved session input facade.
		 * @param fallbackInput - render-time InputState for a facade without snapshot.
		 * @returns the span and its source, or null when no safe span exists.
		 */
		function forgeInsertSpan(target, fallbackInput) {
			const liveInput = inputSnapshot(target);
			const input = liveInput || fallbackInput;
			const detectEnd = referenceDetectEnd(input);
			const rev = input && Number.isSafeInteger(input.draftRev) ? input.draftRev : null;
			if (detectEnd === null || rev === null) {
				forgeTrace("span.invalid", { hasLiveInput: Boolean(liveInput), detectEnd, rev });
				return null;
			}
			forgeTrace("caret", { shellRev: rev, detectEnd, atEnd: true });
			return { span: { start: detectEnd, end: detectEnd, draftRev: rev }, source: "draft-end" };
		}

		/**
		 * Atomically attach one picked issue/PR as a real reference chip. A failed
		 * span/CAS/phase check must leave the draft unchanged: expanding the model
		 * form into the editor is not an acceptable degradation of the chip-shaped
		 * UI contract. The caller keeps the picker open so the user can retry.
		 * @param args - item, resolved facade, and render-time fallback InputState.
		 * @returns true only when the chip landed.
		 */
		function attachForgeReference(args) {
			const item = args.item;
			const ref = encodeForgeRef(item);
			if (!ref) return false;
			const reference = {
				source: FORGE_SOURCE,
				ref,
				label: forgeItemLabel(item),
				// No `appearance`: ReferenceInsert allows only session/file/folder,
				// and an issue/PR is none of them.
				/* The chip's marker is "#", NOT "@": "@" wakes the official
				   attachment/reference sources, so an "@N" chip put their menu and
				   ours on the same keystroke. `clipboardText` is only the
				   clipboard/persistence projection — the official field doc says
				   "never the model form" — so the send-time payload is unaffected
				   (see the codec's `trigger` for why it stays "@"). */
				clipboardText: forgeClipboardText(ref),
			};
			const target = args.sessionInput;
			const phase = target && target.snapshot ? target.snapshot.phase : null;
			forgeTrace("attach", { number: item.number, kind: item.kind, phase, target: Boolean(target) });
			let done = false;
			let chipError = null;
			if (target && typeof target.insertReference === "function") {
				try {
					const picked = forgeInsertSpan(target, args.fallbackInput);
					if (picked) {
						done = target.insertReference(reference, picked.span) === true;
						forgeTrace("insert", { ok: done, source: picked.source, span: picked.span });
					} else {
						chipError = t("forge.attachFailedRejected");
					}
				} catch (error) {
					chipError = String((error && error.message) || error);
					forgeTrace("insert.threw", { message: chipError });
				}
			} else {
				forgeTrace("insert.skipped", { hasTarget: Boolean(target) });
			}
			if (done) {
				forgeTrace("done", { chip: true });
				return true;
			}
			const writable = phase === "plain" || phase === "claimed";
			const reason = chipError || t(writable ? "forge.attachFailedRejected" : "forge.attachFailedNoTarget");
			forgeTrace("done", { chip: false, reason });
			try {
				if (target && typeof target.notify === "function") target.notify("error", t("forge.attachFailed", { reason }));
			} catch { /* the notice is best-effort */ }
			return false;
		}

		/**
		 * paseo's renderChangeRequestAttachment / renderIssueAttachment: the
		 * MODEL form of one reference. The composer shows the chip label; this
		 * text is what the agent receives (ADR 0008).
		 */
		function renderForgeReferenceText(item) {
			const lines = [];
			if (item.kind === "change_request") {
				lines.push("GitHub PR #" + item.number + ": " + (item.title || ""));
				if (item.url) lines.push(item.url);
				if (item.baseRefName) lines.push("Base: " + item.baseRefName);
				if (item.headRefName) lines.push("Head: " + item.headRefName);
			} else {
				lines.push("GitHub Issue #" + item.number + ": " + (item.title || ""));
				if (item.url) lines.push(item.url);
			}
			if (item.body) lines.push("", item.body);
			return lines.join("\n");
		}

		async function fetchForgeItem(cwd, ref, signal) {
			const identity = decodeForgeRef(ref);
			if (!identity || identity.version !== 1) throw new Error(t("forge.detailFailed"));
			const cwds = [];
			if (typeof cwd === "string" && cwd) cwds.push(cwd);
			try {
				const snapshot = appCtx.sessions.list.getSnapshot();
				for (const sessionId of snapshot.ids || []) {
					const candidate = snapshot.byId[sessionId]?.cwd;
					if (typeof candidate === "string" && candidate && cwds.indexOf(candidate) === -1) cwds.push(candidate);
				}
			} catch { /* use any preferred cwd */ }
			if (cwds.length === 0) throw new Error(t("forge.detailFailed"));
			let last = null;
			for (const candidateCwd of cwds) {
				const selector = identity.version === 1
					? { cwd: candidateCwd, number: identity.number, kind: identity.kind, host: identity.host, owner: identity.owner, repo: identity.repo }
					: { cwd: candidateCwd, number: identity.number };
				const result = await apiGet("/pull" + qs(selector), signal);
				last = result;
				if (!result || !result.ok || !result.item) {
					if (identity.version === 1
						&& (result?.error === "repository identity changed" || result?.authState === "no_remote")) continue;
					throw new Error(failureMessage(result) || t("forge.detailFailed"));
				}
				const returnedRef = forgeItemKey(result.item);
				if (identity.version === 1 && returnedRef !== ref) throw new Error(t("forge.detailFailed"));
				if (returnedRef) cacheForgeItem(returnedRef, result.item);
				return result.item;
			}
			throw new Error(failureMessage(last) || t("forge.detailFailed"));
		}

		/** The current session's cwd — the repo `gh` resolves against. */
		function currentCwd() {
			try {
				const snapshot = appCtx.sessions.list.getSnapshot();
				const summary = snapshot && snapshot.current ? snapshot.byId[snapshot.current] : null;
				return summary && typeof summary.cwd === "string" && summary.cwd !== "" ? summary.cwd : null;
			} catch {
				return null;
			}
		}

		/** One row: number, title, kind glyph, fork/state hint. */
		function ForgeRow(props) {
			const item = props.item;
			return h("button", {
				type: "button", className: "dsh-bw-forge-row", "data-attached": String(Boolean(props.attached)),
				disabled: Boolean(props.attached), "aria-disabled": Boolean(props.attached),
				onClick: () => props.onPick(item),
			},
				h("span", { className: "dsh-bw-forge-icon" },
					item.kind === "change_request" ? h(PullIcon) : h(IssueIcon)),
				h("span", { className: "dsh-bw-forge-num" }, "#" + item.number),
				h("span", { className: "dsh-bw-forge-title" }, item.title || ""),
				h("span", { className: "dsh-bw-forge-meta" },
					item.kind === "change_request" && item.fork ? t("forge.fork") : item.state || ""));
		}

		function PullIcon() {
			return h("svg", { width: "13", height: "13", viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true" },
				h("path", { d: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" }));
		}

		function IssueIcon() {
			return h("svg", { width: "13", height: "13", viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true" },
				h("path", { d: "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" }),
				h("path", { d: "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" }));
		}

		/** The picker: one searchable page of issues + PRs, local filtering. */
		function ForgePicker(props) {
			const [query, setQuery] = useState("");
			const [state, setState] = useState({ status: "loading", items: [], authState: null, error: null });
			const inputRef = useRef(null);
			const dialogRef = useRef(null);
			const previousFocus = useRef(null);
			const closeRef = useRef(props.onClose);
			closeRef.current = props.onClose;

			useEffect(() => {
				let alive = true;
				const controller = new AbortController();
				setState({ status: "loading", items: [], authState: null, error: null });
				apiGet("/pulls" + qs({ cwd: props.cwd }), controller.signal)
					.then((result) => {
						if (!alive) return;
						if (!result || !result.ok) {
							setState({ status: "error", items: [], authState: null, error: failureMessage(result) || t("forge.loadFailed") });
							return;
						}
						for (const item of result.items || []) { const key = forgeItemKey(item); if (key) cacheForgeItem(key, item); }
						setState({ status: "ready", items: result.items || [], authState: result.authState || null, error: result.authState === "partial" ? result.error || t("forge.loadFailed") : null });
					})
					.catch((error) => {
						if (alive) setState({ status: "error", items: [], authState: null, error: String((error && error.message) || error) });
					});
				return () => { alive = false; controller.abort(); };
			}, [props.cwd]);

			useEffect(() => {
				previousFocus.current = document.activeElement;
				if (inputRef.current) inputRef.current.focus();
				const onKey = (event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						closeRef.current();
						return;
					}
					if (event.key !== "Tab" || !dialogRef.current) return;
					const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')]
						.filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
					if (!focusable.length) return;
					const first = focusable[0];
					const last = focusable[focusable.length - 1];
					if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
					else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
				};
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("keydown", onKey, true);
					const target = previousFocus.current;
					if (target && target.isConnected && typeof target.focus === "function") target.focus();
				};
			}, []);

			const needle = query.trim().toLowerCase();
			const items = needle === ""
				? state.items
				: state.items.filter((item) =>
					String(item.number).indexOf(needle) !== -1 ||
					(item.title || "").toLowerCase().indexOf(needle) !== -1);

			let body;
			if (state.status === "loading") body = h("div", { className: "dsh-bw-forge-empty", role: "status", "aria-live": "polite" }, t("diff.loading"));
			else if (state.status === "error") body = h("div", { className: "dsh-bw-forge-empty", role: "alert" }, state.error);
			else if (state.authState && state.authState !== "authenticated" && state.authState !== "partial") {
				body = h("div", { className: "dsh-bw-forge-empty", role: "alert" }, t("forge.auth." + state.authState));
			} else if (items.length === 0) {
				body = h("div", { className: "dsh-bw-forge-empty", role: "status", "aria-live": "polite" }, t(needle === "" ? "forge.empty" : "forge.noResults"));
			} else {
				body = h("div", null,
					state.authState === "partial" ? h("div", { className: "dsh-bw-forge-empty", role: "status", "aria-live": "polite" }, state.error) : null,
					h("div", { className: "dsh-bw-forge-list" }, items.map((item) => h(ForgeRow, {
						key: item.kind + ":" + item.number, item,
						attached: props.attached.indexOf(forgeItemKey(item)) !== -1,
						onPick: props.onPick,
					}))));
			}

			return h("div", {
				className: "dsh-bw-forge-overlay",
				onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose(); },
			},
				h("div", {
					ref: dialogRef, className: "dsh-bw-forge-dialog", role: "dialog", "aria-modal": "true",
					"aria-labelledby": "dsh-bw-forge-title", "aria-describedby": "dsh-bw-forge-hint",
				},
					h("div", { className: "dsh-bw-forge-head" },
						h("div", { id: "dsh-bw-forge-title", className: "dsh-bw-forge-titlebar" }, t("forge.pickerTitle")),
						h("input", {
							ref: inputRef, className: "dsh-bw-forge-search", type: "text", "aria-label": t("forge.searchPlaceholder"),
							value: query, placeholder: t("forge.searchPlaceholder"),
							onChange: (event) => setQuery(event.target.value),
						}),
						h("button", { type: "button", className: "dsh-bw-forge-close", onClick: props.onClose, "aria-label": t("forge.close") }, "×")),
					body,
					h("div", { id: "dsh-bw-forge-hint", className: "dsh-bw-forge-hint" }, t("forge.hint"))));
		}

		/**
		 * The composer's forge button — the third round control of the tool row,
		 * registered in `conversation.input.left` (the only additive slot there;
		 * the native "+" command menu and paperclip file picker are hardcoded
		 * and stay untouched). Picking a row attaches a reference chip; the
		 * chip's own codec expands it into the full paseo text at submit time,
		 * so the draft stays clean.
		 */
		function ForgeAttachControl(props) {
			const sessionId = props.sessionId;
			const sessions = appCtx.sessions;
			const listState = useSyncExternalStore(
				sessions.list.subscribe,
				() => sessions.list.getSnapshot(),
				() => sessions.list.getSnapshot(),
			);
			const summary = sessionId ? listState.byId[sessionId] : undefined;
			const cwd = summary && typeof summary.cwd === "string" && summary.cwd !== "" ? summary.cwd : null;
			const [open, setOpen] = useState(false);
			// The selector is REQUIRED, not optional: SnapshotSelectorHook is
			// `<S>(sel: (s: T) => S, eq?) => S`, so a bare useInput() invokes
			// `undefined` inside render and the control dies with a TypeError —
			// invisibly, because the registration stays in the slot registry
			// while the component never mounts (ADR 0009).
			const input = typeof props.useInput === "function" ? props.useInput((s) => s) : null;
			const draft = input && typeof input.draft === "string" ? input.draft : "";
			const draftRev = input && typeof input.draftRev === "number" ? input.draftRev : 0;
			const inputPhase = input && typeof input.phase === "string" ? input.phase : "plain";
			const occurrences = input && Array.isArray(input.occurrences) ? input.occurrences : [];
			let composerBlockStore = null;
			try {
				const conversation = appCtx.get("conversation");
				composerBlockStore = conversation && conversation.blocks ? conversation.blocks.storeFor(sessionId) : null;
			} catch { /* unavailable */ }
			const composerBlock = useSyncExternalStore(
				(listener) => composerBlockStore ? composerBlockStore.subscribe(listener) : () => {},
				() => composerBlockStore ? composerBlockStore.getSnapshot() : undefined,
				() => undefined,
			);
			const restoreProbe = useRef({ sessionId: null, done: false });
			if (restoreProbe.current.sessionId !== sessionId) restoreProbe.current = { sessionId, done: false };
			useEffect(() => () => {
				setForgeDraftBlock(sessionId, false);
				forgeDraftRehydration.delete(sessionId);
			}, [sessionId]);
			useLayoutEffect(() => {
				const pending = forgeDraftRehydration.has(sessionId);
				if (pending || occurrences.some((entry) => entry && entry.source === FORGE_SOURCE)) {
					if (pending) setForgeDraftBlock(sessionId, true);
					settleForgeDraftSidecar(sessionId, input, resolveForgeSessionInput(sessions, sessionId));
					if (forgeDraftRehydration.has(sessionId)) setForgeDraftBlock(sessionId, true);
					else {
						restoreProbe.current.done = true;
						setForgeDraftBlock(sessionId, false);
					}
					return;
				}
				const embedded = embeddedForgeDraft(draft);
				if (restoreProbe.current.done && embedded) restoreProbe.current.done = false;
				if (restoreProbe.current.done) {
					setForgeDraftBlock(sessionId, false);
					try { localStorage.removeItem(forgeDraftStorageKey(sessionId)); } catch { /* unavailable */ }
					return;
				}
				const saved = readForgeDraftSidecar(sessionId);
				const stored = saved && saved.draft === draft ? saved : embedded;
				if (!stored) {
					// The official store may seed after the slot's first empty render;
					// wait for it instead of deleting the only identity-bearing record.
					if (draft === "" && saved && saved.draft !== "") return;
					restoreProbe.current.done = true;
					setForgeDraftBlock(sessionId, false);
					return;
				}
				if (draft === stored.draft) {
					setForgeDraftBlock(sessionId, true);
					settleForgeDraftSidecar(sessionId, input, resolveForgeSessionInput(sessions, sessionId));
					return;
				}
				restoreProbe.current.done = true;
				setForgeDraftBlock(sessionId, false);
				try { localStorage.removeItem(forgeDraftStorageKey(sessionId)); } catch { /* unavailable */ }
			}, [sessionId, draft, draftRev, inputPhase, occurrences, composerBlock]);

			/* Diagnostics: is this control actually being fed live input state? A
			   parent that stops re-projecting would freeze `draftRev` here, and the
			   shell's span CAS would then reject every chip while the draft-end
			   fallback silently no-ops on an unchanged draft. Reported once per
			   session, and only while the opt-in channel is on. */
			const probe = useRef(null);
			if (forgeDebugOn() && probe.current !== sessionId) {
				probe.current = sessionId;
				forgeTrace("control", {
					sessionId: String(sessionId),
					hasUseInput: typeof props.useInput === "function",
					hasInput: Boolean(input),
					draftLength: draft.length,
					draftRev,
					occurrences: occurrences.length,
					hasActions: Boolean(props.inputActions),
				});
			}

			const forgeControlDisabled = Boolean(composerBlock) || !["plain", "claimed"].includes(inputPhase);
			useEffect(() => { if (forgeControlDisabled) setOpen(false); }, [forgeControlDisabled]);

			const attached = occurrences
				.filter((occurrence) => occurrence && occurrence.source === FORGE_SOURCE && decodeForgeRef(occurrence.ref))
				.map((occurrence) => occurrence.ref);

			/** One pick: attach atomically; a rejected insert leaves both the draft
			    and picker intact so the user can retry or cancel. */
			function insert(item) {
				const landed = attachForgeReference({
					item,
					sessionInput: resolveForgeSessionInput(sessions, sessionId),
					fallbackInput: input,
				});
				forgeTrace("pick", { number: item.number, landed });
				if (landed) {
					rememberForgeItem(item, sessionId);
					setOpen(false);
				}
			}

			if (!cwd) return null;
			return h("div", { className: "dsh-bw-forge" },
				h("button", {
					type: "button", className: "dsh-bw-forge-btn", onClick: () => setOpen(true), disabled: forgeControlDisabled,
					"data-armed": String(attached.length > 0), "aria-haspopup": "dialog", "aria-expanded": open,
					"aria-label": t("forge.addIssuePr"), title: t("forge.addIssuePr"),
				},
					h(ForgeIcon),
					attached.length > 0 ? h("span", { className: "dsh-bw-forge-count" }, String(attached.length)) : null),
				open ? h(ForgePicker, {
					cwd, attached,
					onClose: () => setOpen(false),
					onPick: (item) => insert(item),
				}) : null);
		}

		/**
		 * The reference source behind the chips publishes the mandatory codec and
		 * answers the candidate pipeline with a deliberately EMPTY list — never by
		 * omitting the hook: `candidates` is required by the
		 * controller's roster loop (it is invoked synchronously on every `@`
		 * hit, so a missing method throws inside the loop and takes every
		 * source ordered after it down with it). The picker is this source's
		 * only door.
		 */
		function createForgeSource() {
			return {
				/* `trigger` MUST stay "@": the official `TriggerChar` union is
				   `'/' | '@'`, this field is the lexicon's key domain, and the
				   candidate roster is keyed off it. It is NOT what the user sees —
				   the chip's marker comes from `codec.clipboardText`, which is only
				   the clipboard/persistence projection. Keeping them different is
				   the point: "@" would wake the official attachment/reference menu
				   on the same keystroke as our chip. */
				trigger: "@",
				name: FORGE_SOURCE,
				/* Empty, but a function: the roster loop calls it on every hit. */
				candidates: async () => [],
				onPick: () => undefined,
				codec: {
					clipboardText: (ref) => forgeClipboardText(ref),
					serialize: async (ref, signal) => {
						if (signal && signal.aborted === true) throw new Error("aborted");
						const item = await fetchForgeItem(currentCwd(), ref, signal);
						if (signal && signal.aborted === true) throw new Error("aborted");
						return renderForgeReferenceText(item);
					},
				},
			};
		}

		/* ================================================================ */
		/* apply                                                             */
		/* ================================================================ */

		const inject = ["slots", "locale", "sessions", "workspaces"];

		function apply(ctx) {
			appCtx = ctx;
			const lifecycleEpoch = ++lifecycleEpochCounter;
			activeLifecycleEpoch = lifecycleEpoch;
			ctx.effect(() => mountCss(), "better-workspaces: client styles");
			ctx.effect(() => () => {
				if (activeLifecycleEpoch === lifecycleEpoch) activeLifecycleEpoch = 0;
				forgeItems.clear();
				forgeAttached.clear();
				forgeDraftRehydration.clear();
				for (const sessionId of [...forgeDraftBlocks.keys()]) setForgeDraftBlock(sessionId, false);
				forgeDraftBlocks.clear();
				workspaceOpenFlights.clear();
				workspaceRenameQueues.clear();
				workspaceMutationLeases.clear();
				detectCache.clear();
				touchedCache.clear();
				touchedSeq.clear();
			}, "better-workspaces: client lifecycle fence");
			// Test-only read hook (see __bwTest): the offline suite has no real
			// conversation service, so it drives the pick path by handing the app
			// ctx a stand-in for it.
			ctx.__bwAppCtx = ctx;
			ctx.effect(() => () => { if (ctx.__bwAppCtx === ctx) delete ctx.__bwAppCtx; }, "better-workspaces: test hook");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "better-workspaces: dictionaries");
			tt = ctx.locale.bind(NS);
			const currentFeed = createGitFeed();
			feed = currentFeed;
			ctx.effect(() => () => {
				currentFeed.dispose();
				if (feed === currentFeed) feed = null;
				if (appCtx === ctx) { appCtx = null; tt = (key) => key; }
			}, "better-workspaces: feed");
			ctx.effect(() => () => {
				let conversation = null;
				try { conversation = ctx.get("conversation"); } catch { /* unavailable */ }
				for (const sessionId of workspaceArchiveBlocks.keys()) {
					try { if (conversation && conversation.blocks) conversation.blocks.set(sessionId, undefined); } catch { /* teardown */ }
				}
				workspaceArchiveBlocks.clear();
			}, "better-workspaces: archive blocks");
			ctx.effect(() => {
				const controller = new AbortController();
				let timer = null;
				const schedule = () => {
					if (controller.signal.aborted || timer !== null) return;
					timer = setTimeout(() => {
						timer = null;
						recoverDeferredWorkspaceDeletions(controller.signal).catch(() => {});
					}, 0);
				};
				const interval = setInterval(schedule, 30000);
				let unsubscribe = () => {};
				try {
					if (ctx.workspaces.list && typeof ctx.workspaces.list.subscribe === "function") {
						unsubscribe = ctx.workspaces.list.subscribe(schedule) || unsubscribe;
					}
				} catch { /* one boot attempt still runs */ }
				schedule();
				return () => {
					controller.abort();
					clearInterval(interval);
					if (timer !== null) clearTimeout(timer);
					try { unsubscribe(); } catch { /* ignore */ }
				};
			}, "better-workspaces: deferred Workspace recovery");

			/* The diff view is an official right-Sidebar page type, not a
			   conversation view: dsh 0.1.5 shipped the sidebar files panel that
			   replaces our own 文件 view, and the diff moved beside it. The
			   registration waits for the sidebar's tab registry instead of
			   declaring it in `inject`, so a dsh without a right sidebar keeps
			   every other surface (hero, badges, worktree staging) alive. */
			ctx.inject(["sidebarRightTabs"], (sidebarCtx) => {
				sidebarCtx.effect(
					() => sidebarCtx.sidebarRightTabs.register(sidebarDiffDefinition()),
					"better-workspaces: diff tab type",
				);
				sidebarCtx.slots.inject("sidebar.right.pane.tab", () => sidebarCtx.slots.register({
					name: "sidebar.right.pane.tab",
					key: SIDEBAR_DIFF_ID,
					inject: (sessionId) => ({ sessionId }),
				}, SidebarDiffBody));
				sidebarCtx.slots.inject("sidebar.right.pane.tab.title", () => sidebarCtx.slots.register({
					name: "sidebar.right.pane.tab.title",
					key: SIDEBAR_DIFF_ID,
				}, SidebarDiffTitle));
			});

			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "git-diff-pill",
				order: 100,
				locale: NS,
				inject: (sessionId) => ({ sessionId }),
			}, GitDiffPill));

			/* The composer's third attach button. The two native controls ("+"
			   for commands, paperclip for files) are hardcoded in the official
			   InputBar and are left untouched — `conversation.input.left` is the
			   only additive slot in that tool row (the others live in the
			   trailing row), and it renders after the native pair and the modes
			   group, i.e. third among the row's round controls.
			   The reference source rides the same effect so a chip inserted by
			   the picker can never outlive its serializer. */
			ctx.inject(["inputTriggers"], (triggerCtx) => {
				triggerCtx.effect(
					() => triggerCtx.inputTriggers.registerSource(createForgeSource()),
					"better-workspaces: forge reference source",
				);
				triggerCtx.slots.inject("conversation.input.left", () => triggerCtx.slots.register({
					name: "conversation.input.left",
					id: "forge-issue-pr",
					order: 200,
					locale: NS,
					inject: (sessionId) => ({ sessionId }),
				}, ForgeAttachControl));
			});

			const sidebar = createSidebarInjector(ctx);
			const hero = createHeroInjector();
			ctx.effect(() => {
				sidebar.start();
				hero.start();
				return () => {
					sidebar.dispose();
					hero.dispose();
				};
			}, "better-workspaces: dom injection");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__bwTest = { mountCss, setTestRuntime, HeroControl, DiffView, failureMessage, mnemonicSlug, basenameOf, collectTouched, normalizeTouchedPaths, heroModeItems, liveDetect, createRequestOwner, acquireWorkspaceMutation, readSessionDraft, sessionsHaveEmptyDrafts, transferSessionDraft, creationRequestKey, heroCreationRequest, clearHeroCreationTx, pillLabel, snapshotMutationKnown, SIDEBAR_DIFF_ID, SIDEBAR_DIFF_KIND, attachForgeReference, referenceDetectEnd, forgeInsertSpan, resolveForgeSessionInput, ForgeAttachControl, ForgePicker, ForgeRow, createForgeSource, forgeItemLabel, renderForgeReferenceText, encodeForgeRef, decodeForgeRef, forgeClipboardText, embeddedForgeDraft, forgeItemKey, fetchForgeItem, readForgeDraftSidecar, writeForgeDraftSidecar, settleForgeDraftSidecar, FORGE_SOURCE, forgeItems, forgeAttached };
		return module.exports;
	}
});
