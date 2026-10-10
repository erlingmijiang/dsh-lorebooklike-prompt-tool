// Browser half of dsh-lorebooklike-prompt-tool：设置里的「世界书提示词」页。
//
// 手写在 lazy-CJS bundle 协议里（window.__ModuleLoader__.load + 返回 cordis 插件
// exports），所以没有构建步骤。运行时拿到的东西全在 shell 冻结的模块表里：
// 只有 react。样式自己注入，不依赖产品内部组件——这样跨 harness 版本重排组件时
// 这一页仍然能用。它依赖的稳定契约只有两个：settings.section 这个设置页座位，
// 以及它自己 host 半边的 HTTP API。
//
// host 半边（lib/index.js）持有真相（rules.json）。这一半只负责渲染、收集表单输入、
// 调 API 写回。写回的是**用户面原始 JSON**，不是引擎归一化后的对象——后者带着
// effectiveChannel / sortKey / routedForCache 这些计算字段，写回文件会把它们固化成
// 用户声明的一部分。
window.__ModuleLoader__.load({
  id: 'dsh-lorebooklike-prompt-tool',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require('react');
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;

    var API = '/lorebook-prompt';

    var LAYERS = [
      ['', '（用默认层）'],
      ['before-persona', '人格之前 · -500'],
      ['persona-prefix', '人格前缀之后 · 1'],
      ['plan', '计划策略 · 500'],
      ['team', '团队策略 · 600'],
      ['ptc', 'PTC 专属 · 800'],
      ['file-reference', '文件引用 · 900'],
      ['tool', '工具说明起点 · 1000'],
      ['tool-policy', '工具政策 · 3150'],
      ['tool-sdk', '工具 SDK · 5000'],
      ['deliverable', '交付物引用 · 9000'],
      ['structured', '结构化输出 · 9900'],
      ['source', 'harness 源码说明 · 10000'],
      ['web', 'web 界面说明 · 10100'],
      ['persona-suffix', '人格后缀 · 10200'],
      ['tail', '最末尾 · 10300'],
    ];
    var CHANNELS = [
      ['system', '系统提示段'],
      ['message', '消息末尾'],
    ];
    var MODES = [
      ['constant', '🔵 蓝灯 · 常驻'],
      ['selective', '🟢 绿灯 · 关键词'],
    ];
    var LOGICS = [
      ['any', '与任意 (any)'],
      ['all', '与所有 (all)'],
      ['notAny', '非任何 (notAny)'],
      ['notAll', '非所有 (notAll)'],
    ];
    var TARGETS = [
      ['injected', 'injected · 该条目的注入正文'],
      ['system', 'system · 整个系统提示'],
      ['user', 'user · 本轮用户消息'],
    ];

    var CSS = [
      '.pr-root{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;color:inherit}',
      '.pr-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.pr-title{font-weight:600;font-size:15px;margin-right:auto}',
      '.pr-path{font-family:ui-monospace,Consolas,monospace;font-size:11px;opacity:.6;word-break:break-all}',
      '.pr-btn{border:1px solid rgba(128,128,128,.45);background:rgba(128,128,128,.10);color:inherit;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}',
      '.pr-btn:hover:not(:disabled){background:rgba(128,128,128,.22)}',
      '.pr-btn:disabled{opacity:.4;cursor:default}',
      '.pr-btn.pr-primary{border-color:rgba(90,160,255,.7);background:rgba(90,160,255,.18)}',
      '.pr-btn.pr-danger{border-color:rgba(220,90,90,.6)}',
      '.pr-split{display:grid;grid-template-columns:minmax(190px,260px) 1fr;gap:12px;flex:1;min-height:0}',
      '.pr-panel{border:1px solid rgba(128,128,128,.3);border-radius:8px;padding:10px;overflow:auto;min-height:0}',
      '.pr-list{display:flex;flex-direction:column;gap:4px}',
      '.pr-item{display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:6px;cursor:pointer;border:1px solid transparent;font-size:12px}',
      '.pr-item:hover{background:rgba(128,128,128,.12)}',
      '.pr-item.pr-sel{background:rgba(90,160,255,.16);border-color:rgba(90,160,255,.5)}',
      '.pr-item.pr-off{opacity:.45}',
      '.pr-item-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pr-badge{font-size:10px;padding:1px 5px;border-radius:4px;border:1px solid rgba(128,128,128,.4);white-space:nowrap}',
      '.pr-b-blue{border-color:rgba(90,160,255,.6);background:rgba(90,160,255,.14)}',
      '.pr-b-green{border-color:rgba(90,200,120,.6);background:rgba(90,200,120,.14)}',
      '.pr-b-warn{border-color:rgba(230,170,60,.7);background:rgba(230,170,60,.16)}',
      '.pr-b-mut{opacity:.6}',
      '.pr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}',
      '.pr-f{display:flex;flex-direction:column;gap:3px;font-size:11px}',
      '.pr-f>span{opacity:.7}',
      '.pr-f input[type=text],.pr-f input[type=number],.pr-f select,.pr-f textarea{width:100%;box-sizing:border-box;border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.08);color:inherit;border-radius:5px;padding:4px 6px;font-size:12px;font-family:inherit}',
      '.pr-f textarea{resize:vertical;font-family:ui-monospace,Consolas,monospace;line-height:1.45}',
      '.pr-f textarea.pr-content{min-height:110px}',
      '.pr-row{display:flex;align-items:center;gap:6px;font-size:12px}',
      '.pr-sec{border-top:1px solid rgba(128,128,128,.25);margin-top:10px;padding-top:10px}',
      '.pr-sec>h4{margin:0 0 8px;font-size:12px;font-weight:600;opacity:.85}',
      '.pr-note{font-size:12px;padding:6px 9px;border-radius:6px;border:1px solid}',
      '.pr-note.pr-ok{border-color:rgba(90,200,120,.55);background:rgba(90,200,120,.12)}',
      '.pr-note.pr-err{border-color:rgba(220,90,90,.6);background:rgba(220,90,90,.12)}',
      '.pr-note.pr-warn{border-color:rgba(230,170,60,.6);background:rgba(230,170,60,.12)}',
      '.pr-rule{display:grid;grid-template-columns:1.4fr .5fr 1.2fr .9fr auto;gap:6px;align-items:end;margin-bottom:6px}',
      '.pr-empty{opacity:.55;font-size:12px;padding:16px;text-align:center}',
      '.pr-hint{font-size:11px;opacity:.6;line-height:1.5}',
    ].join('\n');

    function installStyles() {
      if (document.getElementById('dsh-lorebooklike-prompt-tool-styles')) return;
      var el = document.createElement('style');
      el.id = 'dsh-lorebooklike-prompt-tool-styles';
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    /** 调 host 半边。同源 fetch，不涉及凭据或代理。 */
    async function call(route, body) {
      var res = await fetch(API + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      var json = {};
      try {
        json = await res.json();
      } catch (e) {
        /* 非 JSON 响应：下面按状态码报错 */
      }
      if (!res.ok || json.ok === false) throw new Error(json.error || 'HTTP ' + res.status);
      return json;
    }

    function clone(v) {
      return JSON.parse(JSON.stringify(v));
    }

    function asArray(v) {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string' && v.length > 0) return [v];
      return [];
    }

    /** 把换行分隔的文本转成数组；空行丢弃。 */
    function linesToArray(text) {
      return String(text)
        .split('\n')
        .map(function (s) {
          return s.trim();
        })
        .filter(function (s) {
          return s.length > 0;
        });
    }

    // ── 小控件 ───────────────────────────────────────────────────────────
    function Field(label, child) {
      return h('label', { className: 'pr-f' }, h('span', null, label), child);
    }

    function TextInput(value, onChange, placeholder) {
      return h('input', {
        type: 'text',
        value: value === undefined || value === null ? '' : String(value),
        placeholder: placeholder || '',
        onChange: function (e) {
          onChange(e.target.value);
        },
      });
    }

    function NumInput(value, onChange, min, max) {
      return h('input', {
        type: 'number',
        value: value === undefined || value === null ? '' : String(value),
        min: min,
        max: max,
        onChange: function (e) {
          var raw = e.target.value;
          if (raw === '') {
            onChange(undefined);
            return;
          }
          var n = Number(raw);
          onChange(Number.isFinite(n) ? n : undefined);
        },
      });
    }

    function Select(value, options, onChange) {
      return h(
        'select',
        {
          value: value === undefined || value === null ? '' : String(value),
          onChange: function (e) {
            onChange(e.target.value);
          },
        },
        options.map(function (pair) {
          return h('option', { key: pair[0], value: pair[0] }, pair[1]);
        }),
      );
    }

    function Check(label, checked, onChange) {
      return h(
        'label',
        { className: 'pr-row' },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          onChange: function (e) {
            onChange(e.target.checked);
          },
        }),
        h('span', null, label),
      );
    }

    // ── 设置页 ───────────────────────────────────────────────────────────
    function PromptRulesPage() {
      var viewState = useState(null);
      var view = viewState[0];
      var setView = viewState[1];

      var draftState = useState(null);
      var draft = draftState[0];
      var setDraft = draftState[1];

      var selState = useState(0);
      var sel = selState[0];
      var setSel = selState[1];

      var noteState = useState(null);
      var note = noteState[0];
      var setNote = noteState[1];

      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var savedRef = useRef('');

      function accept(state) {
        setView(state);
        setDraft(clone(state.raw));
        savedRef.current = JSON.stringify(state.raw);
        setNote(null);
      }

      async function load() {
        setBusy(true);
        try {
          var r = await call('/state');
          accept(r.state);
        } catch (e) {
          setNote({ kind: 'err', text: '读取失败：' + e.message });
        } finally {
          setBusy(false);
        }
      }

      useEffect(function () {
        load();
        // 只在挂载时拉一次；后续刷新靠按钮
        // eslint-disable-next-line
      }, []);

      var dirty = draft !== null && JSON.stringify(draft) !== savedRef.current;

      function patch(mutator) {
        setDraft(function (prev) {
          if (prev === null) return prev;
          var next = clone(prev);
          mutator(next);
          return next;
        });
      }

      function patchEntry(index, key, value) {
        patch(function (next) {
          var e = next.entries[index];
          if (!e) return;
          if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
            delete e[key];
          } else {
            e[key] = value;
          }
        });
      }

      async function save() {
        setBusy(true);
        try {
          var r = await call('/save', { raw: draft });
          accept(r.state);
          if (r.dropped && r.dropped.length > 0) {
            setNote({ kind: 'warn', text: '已保存，但有条目不会生效：' + r.dropped.join('；') });
          } else {
            setNote({ kind: 'ok', text: '已保存并立即生效（无需重启）' });
          }
        } catch (e) {
          setNote({ kind: 'err', text: '保存失败：' + e.message });
        } finally {
          setBusy(false);
        }
      }

      async function reload() {
        setBusy(true);
        try {
          var r = await call('/reload');
          accept(r.state);
          setNote({ kind: 'ok', text: '已从磁盘重新读取' });
        } catch (e) {
          setNote({ kind: 'err', text: '重新读取失败：' + e.message });
        } finally {
          setBusy(false);
        }
      }

      function addEntry() {
        var n = draft && Array.isArray(draft.entries) ? draft.entries.length : 0;
        var id = 'entry-' + (n + 1);
        patch(function (next) {
          if (!Array.isArray(next.entries)) next.entries = [];
          next.entries.push({
            id: id,
            comment: '',
            enabled: true,
            channel: 'system',
            mode: 'constant',
            probability: 100,
            content: '',
          });
        });
        setSel(n);
      }

      function duplicateEntry(index) {
        patch(function (next) {
          var src = next.entries[index];
          if (!src) return;
          var copy = clone(src);
          copy.id = String(src.id || 'entry') + '-copy';
          next.entries.splice(index + 1, 0, copy);
        });
        setSel(index + 1);
      }

      function removeEntry(index) {
        patch(function (next) {
          next.entries.splice(index, 1);
        });
        setSel(function (prev) {
          return Math.max(0, Math.min(prev, (draft.entries.length || 1) - 2));
        });
      }

      if (draft === null || view === null) {
        // 早退分支必须把 note 一起渲染出来。否则首次加载失败时用户只看到
        // 「没有可用状态」——错误原因被吞掉，页面看起来就是坏了且无从排查。
        return h(
          'div',
          { className: 'pr-root' },
          h('div', { className: 'pr-title' }, '世界书提示词'),
          note ? h('div', { className: 'pr-note pr-' + note.kind }, note.text) : null,
          h('div', { className: 'pr-empty' }, busy ? '载入中…' : '还没有拿到规则状态'),
          h(
            'div',
            { className: 'pr-bar' },
            h('button', { className: 'pr-btn', disabled: busy, onClick: load }, '重试'),
          ),
        );
      }

      var entries = Array.isArray(draft.entries) ? draft.entries : [];
      var summaries = Array.isArray(view.entries) ? view.entries : [];
      var cur = entries[sel];
      var sum = summaries[sel];
      var defaults = draft.defaults || {};

      function patchDefaults(key, value) {
        patch(function (next) {
          if (!next.defaults) next.defaults = {};
          if (value === undefined || value === '') delete next.defaults[key];
          else next.defaults[key] = value;
        });
      }

      var notes = [];
      if (note) notes.push(h('div', { key: 'n', className: 'pr-note pr-' + note.kind }, note.text));
      if (dirty) notes.push(h('div', { key: 'd', className: 'pr-note pr-warn' }, '有未保存的改动'));

      return h(
        'div',
        { className: 'pr-root' },

        // 顶栏
        h(
          'div',
          { className: 'pr-bar' },
          h('div', { className: 'pr-title' }, '世界书提示词'),
          h(
            'button',
            { className: 'pr-btn', disabled: busy, onClick: reload },
            '重新读取',
          ),
          h(
            'button',
            { className: 'pr-btn pr-primary', disabled: busy || !dirty, onClick: save },
            dirty ? '保存' : '已保存',
          ),
          h('button', { className: 'pr-btn', disabled: busy, onClick: addEntry }, '+ 新增条目'),
        ),
        h('div', { className: 'pr-path' }, '规则文件：' + view.path),

        notes,

        // 全局设定
        h(
          'div',
          { className: 'pr-panel' },
          h('h4', { style: { margin: '0 0 8px', fontSize: '12px', opacity: 0.85 } }, '全局设定'),
          h(
            'div',
            { className: 'pr-grid' },
            h('div', null, Check('缓存安全（绿灯改注入到消息末尾）', defaults.cacheSafe !== false, function (v) {
              patchDefaults('cacheSafe', v === true ? undefined : false);
            })),
            Field('回看条数 scanDepth', NumInput(defaults.scanDepth, function (v) {
              patchDefaults('scanDepth', v);
            }, 1, 50)),
            h('div', null, Check('大小写敏感', defaults.caseSensitive === true, function (v) {
              patchDefaults('caseSensitive', v ? true : undefined);
            })),
            h('div', null, Check('全词匹配', defaults.matchWholeWords === true, function (v) {
              patchDefaults('matchWholeWords', v ? true : undefined);
            })),
          ),
          h(
            'div',
            { className: 'pr-hint', style: { marginTop: '8px' } },
            '缓存安全开启时，「绿灯 + 系统提示段」的条目会被自动改注入到消息末尾。',
            '系统提示是请求前缀，绿灯逐轮开关会让整段上下文缓存失效，token 成本成倍上升。',
            '想保留原语义：关掉这个开关，或只给某一条加 cacheUnsafe。',
          ),
        ),

        // 列表 + 编辑
        h(
          'div',
          { className: 'pr-split' },
          h(
            'div',
            { className: 'pr-panel' },
            h(
              'div',
              { className: 'pr-list' },
              entries.map(function (entry, i) {
                var s = summaries[i] || {};
                var badges = [];
                badges.push(
                  h(
                    'span',
                    {
                      key: 'm',
                      className: 'pr-badge ' + (entry.mode === 'selective' ? 'pr-b-green' : 'pr-b-blue'),
                    },
                    entry.mode === 'selective' ? '绿' : '蓝',
                  ),
                );
                if (s.routedForCache) badges.push(h('span', { key: 'c', className: 'pr-badge pr-b-warn' }, '改道'));
                if (entry.probability !== undefined && Number(entry.probability) < 100) {
                  badges.push(h('span', { key: 'p', className: 'pr-badge pr-b-mut' }, entry.probability + '%'));
                }
                if (s.dropped) badges.push(h('span', { key: 'x', className: 'pr-badge pr-b-warn' }, '无效'));
                return h(
                  'div',
                  {
                    key: i,
                    className: 'pr-item' + (i === sel ? ' pr-sel' : '') + (entry.enabled === false ? ' pr-off' : ''),
                    onClick: function () {
                      setSel(i);
                    },
                  },
                  h(
                    'div',
                    { className: 'pr-item-main', title: String(entry.comment || entry.id || '') },
                    String(entry.comment || entry.id || '(未命名)'),
                  ),
                  badges,
                );
              }),
              entries.length === 0 ? h('div', { className: 'pr-empty' }, '还没有条目，点上面「新增条目」') : null,
            ),
          ),

          h(
            'div',
            { className: 'pr-panel' },
            cur === undefined
              ? h('div', { className: 'pr-empty' }, '左侧选一个条目，或新增一个')
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'pr-grid' },
                    Field('ID', TextInput(cur.id, function (v) {
                      patchEntry(sel, 'id', v);
                    }, 'entry-1')),
                    Field('说明（只给人看）', TextInput(cur.comment, function (v) {
                      patchEntry(sel, 'comment', v);
                    })),
                    Field('通道', Select(cur.channel || 'system', CHANNELS, function (v) {
                      patchEntry(sel, 'channel', v === 'system' ? undefined : v);
                    })),
                    Field('模式', Select(cur.mode || 'constant', MODES, function (v) {
                      patchEntry(sel, 'mode', v === 'constant' ? undefined : v);
                    })),
                    Field('分层锚点', Select(cur.layer || '', LAYERS, function (v) {
                      patchEntry(sel, 'layer', v);
                    })),
                    Field('层内序（数字越大越靠后）', NumInput(cur.order, function (v) {
                      patchEntry(sel, 'order', v === 0 ? undefined : v);
                    })),
                  ),

                  h(
                    'div',
                    { className: 'pr-row', style: { marginTop: '8px', flexWrap: 'wrap' } },
                    Check('启用', cur.enabled !== false, function (v) {
                      patchEntry(sel, 'enabled', v ? undefined : false);
                    }),
                    Check('cacheUnsafe（允许它留在系统提示里）', cur.cacheUnsafe === true, function (v) {
                      patchEntry(sel, 'cacheUnsafe', v ? true : undefined);
                    }),
                  ),

                  sum && sum.routedForCache
                    ? h(
                        'div',
                        { className: 'pr-note pr-warn', style: { marginTop: '8px' } },
                        '这条声明的是「系统提示段」，但因为它会逐轮开关，已被缓存安全改注入到消息末尾。',
                      )
                    : null,
                  sum && sum.dropped
                    ? h('div', { className: 'pr-note pr-err', style: { marginTop: '8px' } }, sum.reason)
                    : null,

                  // 关键词
                  h(
                    'div',
                    { className: 'pr-sec' },
                    h('h4', null, '激活条件'),
                    h(
                      'div',
                      { className: 'pr-grid' },
                      Field('主键（每行一个，支持 /正则/flags）',
                        h('textarea', {
                          rows: 3,
                          value: asArray(cur.keys).join('\n'),
                          onChange: function (e) {
                            var arr = linesToArray(e.target.value);
                            patchEntry(sel, 'keys', arr.length ? arr : undefined);
                          },
                        }),
                      ),
                      Field('副键（每行一个）',
                        h('textarea', {
                          rows: 3,
                          value: asArray(cur.keySecondary).join('\n'),
                          onChange: function (e) {
                            var arr = linesToArray(e.target.value);
                            patchEntry(sel, 'keySecondary', arr.length ? arr : undefined);
                          },
                        }),
                      ),
                      Field('副键逻辑', Select(cur.keyLogic || 'any', LOGICS, function (v) {
                        patchEntry(sel, 'keyLogic', v === 'any' ? undefined : v);
                      })),
                      Field('概率 %（0-100）', NumInput(cur.probability === undefined ? 100 : cur.probability, function (v) {
                        patchEntry(sel, 'probability', v === undefined || v === 100 ? undefined : v);
                      }, 0, 100)),
                      Field('seedSalt（换一条随机序列）', TextInput(cur.seedSalt, function (v) {
                        patchEntry(sel, 'seedSalt', v);
                      })),
                      Field('扫描深度（回看几条消息）', NumInput(cur.scanDepth, function (v) {
                        patchEntry(sel, 'scanDepth', v);
                      }, 1, 50)),
                    ),
                    h(
                      'div',
                      { className: 'pr-row', style: { marginTop: '8px', flexWrap: 'wrap' } },
                      Check('keys 当正则', cur.keyIsRegex === true, function (v) {
                        patchEntry(sel, 'keyIsRegex', v ? true : undefined);
                      }),
                      Check('大小写敏感', cur.caseSensitive === true, function (v) {
                        patchEntry(sel, 'caseSensitive', v ? true : undefined);
                      }),
                      Check('全词匹配', cur.matchWholeWords === true, function (v) {
                        patchEntry(sel, 'matchWholeWords', v ? true : undefined);
                      }),
                    ),
                  ),

                  // 正文
                  h(
                    'div',
                    { className: 'pr-sec' },
                    h('h4', null, '注入正文'),
                    h('textarea', {
                      className: 'pr-content',
                      rows: 6,
                      value: cur.content === undefined ? '' : String(cur.content),
                      onChange: function (e) {
                        patchEntry(sel, 'content', e.target.value);
                      },
                      placeholder: '命中后注入到模型上下文里的文本',
                    }),
                  ),

                  // 正则替换
                  h(
                    'div',
                    { className: 'pr-sec' },
                    h(
                      'div',
                      { className: 'pr-bar' },
                      h('h4', { style: { margin: 0, marginRight: 'auto' } }, '正则替换'),
                      h(
                        'button',
                        {
                          className: 'pr-btn',
                          onClick: function () {
                            patch(function (next) {
                              var e = next.entries[sel];
                              if (!Array.isArray(e.replaces)) e.replaces = [];
                              e.replaces.push({ target: 'injected', pattern: '', flags: 'g', replacement: '' });
                            });
                          },
                        },
                        '+ 加一条',
                      ),
                    ),
                    asArray(cur.replaces).map(function (rule, ri) {
                      var patchRule = function (key, value) {
                        patch(function (next) {
                          var list = next.entries[sel].replaces;
                          if (!list || !list[ri]) return;
                          if (value === '' || value === undefined) delete list[ri][key];
                          else list[ri][key] = value;
                        });
                      };
                      return h(
                        'div',
                        { className: 'pr-rule', key: ri },
                        Field('匹配（正则）', TextInput(rule.pattern, function (v) {
                          patchRule('pattern', v);
                        }, '\\bfoo\\b')),
                        Field('flags', TextInput(rule.flags, function (v) {
                          patchRule('flags', v);
                        }, 'g')),
                        Field('替换为', TextInput(rule.replacement, function (v) {
                          patchRule('replacement', v);
                        }, '$1')),
                        Field('作用面', Select(rule.target || 'injected', TARGETS, function (v) {
                          patchRule('target', v);
                        })),
                        h(
                          'button',
                          {
                            className: 'pr-btn pr-danger',
                            title: '删除这条替换',
                            onClick: function () {
                              patch(function (next) {
                                next.entries[sel].replaces.splice(ri, 1);
                                if (next.entries[sel].replaces.length === 0) delete next.entries[sel].replaces;
                              });
                            },
                          },
                          '✕',
                        ),
                      );
                    }),
                    asArray(cur.replaces).length === 0
                      ? h('div', { className: 'pr-hint' }, '没有替换规则。作用面：injected=只改这条注入的正文；system=改整个系统提示（别人的段也会被改）；user=改本轮用户消息。')
                      : null,
                  ),

                  // 危险操作
                  h(
                    'div',
                    { className: 'pr-sec pr-bar' },
                    h(
                      'button',
                      { className: 'pr-btn', onClick: function () { duplicateEntry(sel); } },
                      '复制这条',
                    ),
                    h(
                      'button',
                      {
                        className: 'pr-btn pr-danger',
                        onClick: function () { removeEntry(sel); },
                      },
                      '删除这条',
                    ),
                    h('span', { className: 'pr-hint' }, '改动要点「保存」才写回文件；保存后立即生效，不用重启。'),
                  ),
                ),
          ),
        ),
      );
    }

    exports.name = 'dsh-lorebooklike-prompt-tool';
    // slots 必须**声明**而不是只查一下：声明过的服务会在 apply 前解析好，
    // 没有提供方时插件就停在 PENDING；而 inject 为空时 ctx.get('slots')
    // 即使服务已经活着也返回 undefined，设置页就永远注册不上。
    exports.inject = ['slots'];

    exports.apply = function apply(ctx) {
      installStyles();
      ctx.effect(function () {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'lorebook-prompt',
              order: 36,
              label: function () {
                return '世界书提示词';
              },
            },
            PromptRulesPage,
          );
        });
      }, 'dsh-lorebooklike-prompt-tool: settings section');
    };

    return module.exports;
  },
});
