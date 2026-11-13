#!/usr/bin/env python3
"""从 site/pages.json + shell.json 生成 preview/cloud-data.js。

词云数据的唯一来源是真实节点：域级大词（shell.json 的中文标签）+
节点级小词（pages[].node，权重 = 该页入选条数 len(picks)）。
纯标准库，任何 python3 可跑：  python3 preview/gen_cloud_data.py
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pages = json.load(open(os.path.join(ROOT, "pages.json")))["pages"]
shell = json.load(open(os.path.join(ROOT, "shell.json")))

labels = {d["id"]: d["label"] for d in shell["domains"]}

domains, nodes = {}, []
for p in pages:
    d = p["domain"]
    domains[d] = domains.get(d, 0) + 1
    nodes.append({"t": p["node"], "d": d, "w": len(p.get("picks") or [])})

out = {
    "domains": [{"id": d, "label": labels.get(d, d), "n": n}
                for d, n in sorted(domains.items(), key=lambda x: -x[1])],
    "nodes": nodes,
}
js = "// 由 gen_cloud_data.py 从 pages.json 生成，别手改\nwindow.CLOUD_DATA = " \
     + json.dumps(out, ensure_ascii=False, indent=1) + ";\n"
open(os.path.join(ROOT, "preview", "cloud-data.js"), "w").write(js)
print("ok: %d domains, %d nodes" % (len(out["domains"]), len(nodes)))
