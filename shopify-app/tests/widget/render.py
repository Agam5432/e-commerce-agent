import re,sys
src=open(sys.argv[1]).read()
src=re.sub(r"\{%\s*schema\s*%\}.*?\{%\s*endschema\s*%\}","",src,flags=re.S)
src=re.sub(r"\{%\s*if customer %\}.*?\{%\s*else\s*%\}(.*?)\{%\s*endif\s*%\}",r"\1",src,flags=re.S)
src=re.sub(r"\{%\s*if customer\.[^%]*%\}.*?\{%\s*endif\s*%\}","",src,flags=re.S)
src=re.sub(r"\{%\s*if customer\s*%\}true\{%\s*else\s*%\}false\{%\s*endif\s*%\}","false",src)
src=src.replace("{{ 'ai-chat-widget.css' | asset_url | stylesheet_tag }}",'<link rel="stylesheet" href="/ai-chat-widget.css">')
src=src.replace("{{ 'ai-chat-widget.js' | asset_url }}","/ai-chat-widget.js")
def sub(m):
    e=m.group(1).strip()
    if e.startswith("block.id"): return "b1"
    if e.startswith("shop.name"): return "Test Shop"
    if e.startswith("shop.permanent_domain"): return "test.myshopify.com"
    if "api_url" in e: return "https://backend.test"
    if "asset_url" in e: return "/x.webp"
    if "routes.cart_url" in e: return "/cart"
    return ""
src=re.sub(r"\{\{(.*?)\}\}",sub,src)
src=re.sub(r"\{%.*?%\}","",src,flags=re.S)
open(sys.argv[2],"w").write("<!doctype html><html><head><meta charset=utf-8></head><body><h1>Store</h1>"+src+"</body></html>")
