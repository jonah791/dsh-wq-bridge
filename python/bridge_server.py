"""dsh-wq-bridge 的 Python 桥服务：stdio JSON-RPC 循环。

协议：stdin 每行一个 JSON 请求 {id, method, params}，stdout 每行一个响应 {id, result} 或 {id, error}。
"""
import sys, json, os

# AlphaFactory 包根（projects/self 是 Python 包根，alphafactory 是其中的包）
ALPHA_ROOT = r"C:/Users/tr/Documents/alice/projects/self"
sys.path.insert(0, ALPHA_ROOT)

_orch = None

def orch():
    """懒加载 AlphaOrchestrator（首次调用时构造，凭据从环境变量读）。"""
    global _orch
    if _orch is None:
        from alphafactory.orchestrator import AlphaOrchestrator
        from alphafactory.config import QuantAlphaConfig
        username = os.environ.get("WQ_USERNAME", "")
        password = os.environ.get("WQ_PASSWORD", "")
        if not username or not password:
            raise RuntimeError("WQ_USERNAME/WQ_PASSWORD 环境变量缺失（.env 需注入）")
        _orch = AlphaOrchestrator(QuantAlphaConfig(
            wq_username=username, wq_password=password,
            output_dir=r"C:/Users/tr/Documents/alice/projects/self/alphafactory/results",
            session_name="v5_auto_20260806",
        ))
    return _orch

import json as _json

def _json_load(fh):
    return _json.load(fh)

def handle(req):
    method = req.get("method", "")
    params = req.get("params") or {}
    if method == "ping":
        return {"ok": True, "pong": True, "py": sys.version.split()[0]}
    if method == "alpha_count":
        o = orch()
        return {"ok": True,
                "submitted": len(o.alpha_submitted),
                "ready": len(o.alpha_ready),
                "candidates": len(o.alpha_candidates),
                "weak": len(o.alpha_weak_pool),
                "waste": len(o.alpha_waste_pool)}
    if method == "quota":
        o = orch()
        try:
            q = o.check_quota()
            return {"ok": True, "quota": q}
        except Exception as e:
            return {"ok": False, "error": f"quota: {e}"}
    if method == "context_explore":
        o = orch()
        try:
            ctx = o.get_context_explore()
            return {"ok": True, "context": ctx}
        except Exception as e:
            return {"ok": False, "error": f"context: {e}"}
    if method == "submitted":
        o = orch()
        return {"ok": True, "submitted": o.get_submitted()}
    if method == "ready":
        o = orch()
        return {"ok": True, "ready": o.get_ready()}
    if method == "weak_pool":
        o = orch()
        return {"ok": True, "weak": o.get_weak_pool()}
    if method == "simulate":
        o = orch()
        expr = params.get("expression", "")
        if not expr:
            return {"ok": False, "error": "expression required"}
        try:
            import time as _t
            result = o.simulate(expr,
                                universe=params.get("universe"),
                                settings_override=params.get("settings_override"))
            return {"ok": True, "simulation": result}
        except Exception as e:
            return {"ok": False, "error": f"simulate: {type(e).__name__}: {e}"}
    if method == "check_expression":
        o = orch()
        expr = params.get("expression", "")
        try:
            r = o.check_expression(expr)
            return {"ok": True, "check": r}
        except Exception as e:
            return {"ok": False, "error": f"check_expression: {e}"}
    if method == "similarity_hint":
        o = orch()
        expr = params.get("expression", "")
        try:
            r = o.similarity_hint(expr)
            return {"ok": True, "hint": r}
        except Exception as e:
            return {"ok": False, "error": f"similarity_hint: {e}"}
    if method == "evaluate_submittability":
        o = orch()
        alpha_id = params.get("alpha_id", "")
        sharpe = params.get("sharpe", 0) or 0
        fitness = params.get("fitness", 0) or 0
        checks = params.get("checks") or {}
        try:
            r = o.evaluate_submittability(alpha_id, sharpe, fitness, checks)
            return {"ok": True, "evaluation": r}
        except Exception as e:
            return {"ok": False, "error": f"evaluate: {e}"}
    if method == "add_to_zoo":
        o = orch()
        try:
            r = o.add_to_zoo(
                expression=params.get("expression", ""),
                alpha_id=params.get("alpha_id", ""),
                mode=params.get("mode", "explore"),
                parent_id=params.get("parent_id"),
                expected_effect=params.get("expected_effect"),
                sharpe=params.get("sharpe", 0) or 0,
                fitness=params.get("fitness", 0) or 0,
                checks=params.get("checks") or {},
                turnover=params.get("turnover"),
                returns=params.get("returns"),
                grade=params.get("grade", ""),
            )
            return {"ok": True, "result": r}
        except Exception as e:
            return {"ok": False, "error": f"add_to_zoo: {type(e).__name__}: {e}"}
    if method == "recover_pending":
        o = orch()
        try:
            r = o.recover_pending()
            return {"ok": True, "result": r}
        except Exception as e:
            return {"ok": False, "error": f"recover: {e}"}
    if method == "context_refine":
        o = orch()
        alpha_id = params.get("alpha_id", "")
        try:
            ctx = o.get_context_refine(alpha_id)
            return {"ok": True, "context": ctx}
        except Exception as e:
            return {"ok": False, "error": f"context_refine: {e}"}
    if method == "suggest_next_round":
        o = orch()
        try:
            # orchestrator 期望 dict 列表（元素含 type 字段），桥接收字符串列表后包装
            recent = params.get("recent_rounds") or []
            wrapped = [{"type": t} if isinstance(t, str) else t for t in recent]
            r = o.suggest_next_round(wrapped)
            return {"ok": True, "suggestion": r}
        except Exception as e:
            return {"ok": False, "error": f"suggest: {e}"}
    if method == "report_blindspot":
        o = orch()
        try:
            r = o.report_blindspot(
                archive=params.get("archive", ""),
                issue=params.get("issue", ""),
                evidence=params.get("evidence", ""),
                fix_suggestion=params.get("fix_suggestion", ""),
                operator=params.get("operator", ""),
                dataset=params.get("dataset", ""),
                family=params.get("family", ""),
            )
            return {"ok": True, "result": r}
        except Exception as e:
            return {"ok": False, "error": f"blindspot: {e}"}
    if method == "mark_as_waste":
        o = orch()
        try:
            r = o.mark_as_waste(params.get("alpha_id", ""), params.get("reason", ""))
            return {"ok": True, "result": r}
        except Exception as e:
            return {"ok": False, "error": f"waste: {e}"}
    if method == "add_weak_signal":
        o = orch()
        try:
            r = o.add_weak_signal(
                expr=params.get("expression", ""),
                alpha_id=params.get("alpha_id", ""),
                sharpe=params.get("sharpe", 0) or 0,
                fitness=params.get("fitness", 0) or 0,
                reason=params.get("reason", ""),
                corr=params.get("corr"),
                force=params.get("force", False),
            )
            return {"ok": True, "result": r}
        except Exception as e:
            return {"ok": False, "error": f"weak: {e}"}
    if method == "corr_with":
        o = orch()
        try:
            r = o.corr_with(params.get("alpha_id", ""), params.get("ref_id", ""))
            return {"ok": True, "corr": r}
        except Exception as e:
            return {"ok": False, "error": f"corr: {e}"}
    if method == "compute_correlation":
        o = orch()
        try:
            r = o.compute_correlation(params.get("alpha_id", ""))
            return {"ok": True, "corr": r}
        except Exception as e:
            return {"ok": False, "error": f"corr: {e}"}
    # ── analyze 域（tools.py 纯计算） ──
    if method == "analyze_parse":
        from alphafactory.tools import parse_expression_tree
        expr = params.get("expression", "")
        try:
            return {"ok": True, "tree": parse_expression_tree(expr)}
        except Exception as e:
            return {"ok": False, "error": f"parse: {e}"}
    if method == "analyze_similarity":
        from alphafactory.tools import expression_similarity
        try:
            s = expression_similarity(params.get("expr1", ""), params.get("expr2", ""))
            return {"ok": True, "similarity": s}
        except Exception as e:
            return {"ok": False, "error": f"similarity: {e}"}
    if method == "analyze_calibrated":
        from alphafactory.tools import calibrated_similarity
        try:
            s = calibrated_similarity(params.get("expr1", ""), params.get("expr2", ""))
            return {"ok": True, "similarity": s}
        except Exception as e:
            return {"ok": False, "error": f"calibrated: {e}"}
    if method == "analyze_classify":
        from alphafactory.tools import classify_expression
        try:
            return {"ok": True, "classification": classify_expression(params.get("expression", ""))}
        except Exception as e:
            return {"ok": False, "error": f"classify: {e}"}
    # ── knowledge 域（档案确定性查询） ──
    if method == "knowledge_blindspots":
        import json as _json
        p = r"C:/Users/tr/Documents/alice/projects/self/alphafactory/results/blindspot_registry.json"
        try:
            with open(p, encoding="utf-8") as fh:
                data = _json.load(fh)
            entries = data if isinstance(data, list) else data.get("blindspots", data.get("entries", []))
            # 过滤：archive/operator/dataset/family
            archive = params.get("archive")
            operator = params.get("operator")
            dataset = params.get("dataset")
            family = params.get("family")
            limit = params.get("limit", 50)
            if archive:
                entries = [e for e in entries if str(e.get("archive", "")).lower() == str(archive).lower()]
            if operator:
                entries = [e for e in entries if operator.lower() in str(e.get("operator", "")).lower()]
            if dataset:
                entries = [e for e in entries if dataset.lower() in str(e.get("dataset", "")).lower()]
            if family:
                entries = [e for e in entries if family.lower() in str(e.get("family", "")).lower()]
            return {"ok": True, "total": len(entries), "entries": entries[:limit]}
        except Exception as e:
            return {"ok": False, "error": f"blindspots: {e}"}
    if method == "knowledge_summary":
        p = r"C:/Users/tr/Documents/alice/projects/self/alphafactory/results/blindspot_summary.json"
        try:
            with open(p, encoding="utf-8") as fh:
                return {"ok": True, "summary": _json_load(fh)}
        except Exception as e:
            return {"ok": False, "error": f"summary: {e}"}
    if method == "knowledge_meme":
        p = r"C:/Users/tr/Documents/alice/projects/self/alphafactory/results/meme_registry.json"
        try:
            with open(p, encoding="utf-8") as fh:
                return {"ok": True, "meme": _json_load(fh)}
        except Exception as e:
            return {"ok": False, "error": f"meme: {e}"}
    if method == "knowledge_templates":
        p = r"C:/Users/tr/Documents/alice/projects/self/alphafactory/results/expression_templates.json"
        try:
            with open(p, encoding="utf-8") as fh:
                return {"ok": True, "templates": _json_load(fh)}
        except Exception as e:
            return {"ok": False, "error": f"templates: {e}"}
    if method == "knowledge_family_tree":
        p = r"C:/Users/tr/Documents/alice/projects/self/alphafactory/results/family_tree.json"
        try:
            with open(p, encoding="utf-8") as fh:
                return {"ok": True, "tree": _json_load(fh)}
        except Exception as e:
            return {"ok": False, "error": f"family_tree: {e}"}
    if method == "knowledge_dead_roots":
        import json as _json2
        base = r"C:/Users/tr/Documents/alice/projects/self/alphafactory/results"
        try:
            extra_p = base + "/dead_semantic_roots_extra.json"
            extra = []
            with open(extra_p, encoding="utf-8") as fh:
                extra = _json2.load(fh)
            # 内置词根从 orchestrator 常量读取
            import re as _re
            src = open(r"C:/Users/tr/Documents/alice/projects/self/alphafactory/orchestrator.py", encoding="utf-8").read()
            m = _re.search(r"_DEAD_SEMANTIC_ROOTS = \((.*?)\)", src, _re.S)
            builtin = _re.findall(r'"(_[a-z0-9_]+)"', m.group(1)) if m else []
            return {"ok": True, "builtin": builtin, "extra": extra, "total": len(builtin) + len(extra)}
        except Exception as e:
            return {"ok": False, "error": f"dead_roots: {e}"}
    return {"ok": False, "error": "unknown method: " + method}

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            result = handle(req)
            resp = {"id": rid, "result": result}
        except Exception as e:
            resp = {"id": rid, "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()

if __name__ == "__main__":
    main()