(function(){
  window.__KX_PLUGIN = {
    id: "fine-detect",
    name: "精细检测",
    version: "1.2",
    type: "feature",
    fine: true,
    description: "开启后使用 1024px 高分辨率分析照片，每张反复检测 3 次并对比判定（多数一致才标记），耗时比标准模式更长，检测结果更准确精细。",
    detect: function(m) { return null; }
  };
})();
