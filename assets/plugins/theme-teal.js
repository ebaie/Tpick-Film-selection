(function(){
  // 青绿主题。浅色 / 暗色各给一套取值：
  // 内置暗色默认值写在 body[data-theme="dark"] 上（styles.css:1228），只写 :root 会被它压掉
  // ——body 离元素更近，继承时胜出。插件样式注入在 <head> 末尾，同特异性下后写者胜，
  // 所以这里用同样的 body[data-theme="dark"] 与内置暗色默认值打平后取胜。
  window.__KX_PLUGIN = {
    id: "theme-teal",
    name: "青绿主题",
    name_en: "Teal theme",
    version: "1.1",
    type: "theme",
    description: "把主色换成青绿色，绿色系更护眼。",
    description_en: "Switches the accent color to teal — a green-toned palette that is easier on the eyes.",
    css: [
      ":root { --accent: #12907f; --accent-bright: #17a894; --accent-deep: #0e7a6c; --accent-soft: rgba(18,144,127,.12); }",
      'body[data-theme="dark"] { --accent: #35c0a8; --accent-bright: #5ad6bd; --accent-deep: #29a892; --accent-soft: rgba(53,192,168,.16); }'
    ].join("\n")
  };
})();
