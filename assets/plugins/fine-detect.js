(function(){
  window.__KX_PLUGIN = {
    id: "fine-detect",
    name: "精细检测",
    name_en: "Fine detection",
    version: "1.2",
    type: "feature",
    fine: true,
    description: "开启后所有分析都使用 1024px 高分辨率逐张检测（标准模式为 512px），更准但更慢。检测模式由本插件控制，阈值面板里不可直接修改；关闭后按标准模式。",
    description_en: "Analyzes every photo at 1024px instead of the standard 512px. More accurate, but slower. The detection mode is controlled by this plugin and cannot be changed in the thresholds panel; turn it off to use standard mode.",
    detect: function(m) { return null; }
  };
})();
