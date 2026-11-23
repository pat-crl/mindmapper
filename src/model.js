/* The model is the saved tree, independent of the screen. Keeping it separate
   lets tests check editing and file validation without running a browser. */
(function (scope) {
  'use strict';
  const VERSION = '0.1.6';
  const SCHEMA = 4;
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = () => globalThis.crypto?.randomUUID?.() || `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const safeID = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);

  // Count encoded bytes, not characters: emoji and non-English text can use
  // several bytes each. Check the same readable JSON that the iPad writes.
  const MAX_LIBRARY_BYTES = 20 * 1024 * 1024;
  const byteLength = text => new TextEncoder().encode(text).length;
  function libraryText(library) {
    const text = JSON.stringify(library, null, 2);
    if (byteLength(text) > MAX_LIBRARY_BYTES) throw new Error('The combined library exceeds 20 MB. Export and remove some maps before adding more.');
    return text;
  }

  function createMap(name = 'Untitled map') {
    const rootId = uid();
    return { id: uid(), name, updatedAt: Date.now(), data: { rootId, nodes: {
      [rootId]: { id: rootId, text: '', parentId: null, children: [], side: null, size: 'title', color: 'default', collapsed: false }
    }, links: [], layoutMode: 'tree', snap: false, connectorStyle: 'soft-s', defaultConnectorType: 'line', zoom: 1, panX: 0, panY: 0 } };
  }

  // Files are untrusted input. Check the complete tree before changing anything
  // in the open library, including cycles, missing parents, and excessive depth.
  function validateLibrary(input) {
    if (!input || ![1, 2, 3, 4].includes(input.version) || !Array.isArray(input.maps) || !input.maps.length || input.maps.length > 200) {
      throw new Error('Expected a version 1, 2, 3, or 4 mindmap library containing 1–200 maps.');
    }
    const mapIDs = new Set();
    const maps = input.maps.map(entry => {
      if (!entry || !safeID(entry.id) || mapIDs.has(entry.id) || typeof entry.name !== 'string' || entry.name.length > 500) throw new Error('Invalid or duplicate map identity.');
      mapIDs.add(entry.id);
      const data = entry.data;
      if (!data || !data.nodes || !safeID(data.rootId) || !own(data.nodes, data.rootId)) throw new Error('The map has no valid central idea.');
      const keys = Object.keys(data.nodes);
      if (keys.length > 2000) throw new Error('A map can contain up to 2,000 ideas.');
      const nodes = {};
      for (const id of keys) {
        const n = data.nodes[id];
        if (!safeID(id) || !n || n.id !== id || typeof n.text !== 'string' || n.text.length > 20000 || !Array.isArray(n.children) || n.children.some(c => !safeID(c)) || new Set(n.children).size !== n.children.length) throw new Error('An idea contains invalid text or child links.');
        if (id === data.rootId ? n.parentId !== null : !(safeID(n.parentId) || input.version >= 3 && n.parentId === null)) throw new Error('An idea has an invalid parent.');
        for (const axis of ['x', 'y']) if (n[axis] !== undefined && (!Number.isFinite(n[axis]) || Math.abs(n[axis]) > 1e6)) throw new Error('An idea is beyond the canvas coordinate limit. Move it closer to the centre.');
        nodes[id] = { id, text: n.text, parentId: n.parentId, children: [...n.children],
          side: n.parentId === null ? null : n.side === 'left' ? 'left' : 'right',
          ...edgeFields(n, data.connectorStyle),
          notes: checkedText(n.notes, 20000, 'Idea notes'),
          source: checkedText(n.source, 2000, 'Source link'),
          x: Number.isFinite(n.x) && Math.abs(n.x) <= 1e6 ? n.x : 0,
          y: Number.isFinite(n.y) && Math.abs(n.y) <= 1e6 ? n.y : 0,
          size: ['title','heading','text'].includes(n.size) ? n.size : 'text',
          color: typeof n.color === 'string' && /^#[0-9a-f]{6}$/i.test(n.color) && n.color !== '#0d0d0d' ? n.color : 'default',
          collapsed: Boolean(n.collapsed) };
      }
      const visited = new Set();
      function visit(id, depth, side) {
        if (!own(nodes, id) || visited.has(id) || depth > 100) throw new Error('The tree has a missing idea, a cycle, or more than 100 levels.');
        visited.add(id);
        const n = nodes[id];
        if (side) n.side = side;
        for (const child of n.children) {
          if (!own(nodes, child) || nodes[child].parentId !== id) throw new Error('A parent and child disagree about their connection.');
          visit(child, depth + 1, side || nodes[child].side);
        }
      }
      for (const id of roots({ rootId: data.rootId, nodes })) visit(id, 0, null);
      if (visited.size !== keys.length) throw new Error('The file contains a broken or circular branch.');
      const finite = (v, fallback, limit) => Number.isFinite(v) && Math.abs(v) <= limit ? v : fallback;
      return { id: entry.id, name: entry.name, updatedAt: finite(entry.updatedAt, Date.now(), 1e15), data: {
        rootId: data.rootId, nodes, links: validateLinks(data.links, nodes, data.connectorStyle),
        layoutMode: data.layoutMode === 'free' ? 'free' : 'tree', snap: Boolean(data.snap),
        defaultConnectorType: ['line','arrow','both'].includes(data.defaultConnectorType) ? data.defaultConnectorType : 'line', connectorStyle: ['straight','soft-s','strict-s'].includes(data.connectorStyle) ? data.connectorStyle : 'soft-s',
        zoom: Math.min(2, Math.max(.15, finite(data.zoom, 1, 2))), panX: finite(data.panX, 0, 1e6), panY: finite(data.panY, 0, 1e6)
      } };
    });
    return { version: SCHEMA, activeMapId: maps.some(m => m.id === input.activeMapId) ? input.activeMapId : maps[0].id, maps };
  }

  function add(data, selected, kind = 'child', side) {
    const node = data.nodes[selected];
    if (!node) return selected;
    const id = uid();
    if (kind === 'parent' && node.parentId) {
      const p = data.nodes[node.parentId];
      data.nodes[id] = { ...node, id, text: '', children: [selected], connectorType: data.defaultConnectorType || 'line', connectorStyle: data.connectorStyle, connectorLabel: '', connectorDashed: false, connectorReverse: false, notes: '', source: '', collapsed: false };
      p.children[p.children.indexOf(selected)] = id;
      node.parentId = id;
      node.connectorType = data.defaultConnectorType || 'line';
    } else {
      const parent = kind === 'sibling' && node.parentId ? data.nodes[node.parentId] : node;
      parent.collapsed = false;
      const siblings = parent.children;
      const chosenSide = side || (parent.parentId === null
        ? (kind === 'sibling' && node.parentId ? node.side : siblings.filter(c => data.nodes[c].side === 'right').length <= siblings.filter(c => data.nodes[c].side === 'left').length ? 'right' : 'left')
        : parent.side);
      data.nodes[id] = { id, text: '', parentId: parent.id, children: [], side: chosenSide, size: parent.parentId === null ? 'heading' : 'text', color: node.color, connectorType: data.defaultConnectorType || 'line', connectorStyle: data.connectorStyle, connectorLabel: '', connectorDashed: false, connectorReverse: false, notes: '', source: '', collapsed: false };
      siblings.splice(kind === 'sibling' && node.parentId ? siblings.indexOf(selected) + 1 : siblings.length, 0, id);
    }
    if (data.layoutMode === 'free') {
      const parent = data.nodes[data.nodes[id].parentId] || node;
      let x = (parent.x || 0) + (data.nodes[id].side === 'left' ? -280 : 280), y = parent.y || 0;
      while (Object.values(data.nodes).some(n => n.id !== id && Math.abs((n.x||0)-x)<250 && Math.abs((n.y||0)-y)<90)) y += 110;
      Object.assign(data.nodes[id], {x,y});
    }
    return id;
  }
  function subtree(data, id) {
    return [id, ...data.nodes[id].children.flatMap(c => subtree(data, c))];
  }
  function remove(data, ids) {
    const doomed = new Set(ids.filter(id => data.nodes[id]).flatMap(id => subtree(data, id)));
    // Keep one starting idea if the selection would erase the entire canvas.
    if (doomed.size === Object.keys(data.nodes).length) doomed.delete(data.rootId);
    for (const id of doomed) delete data.nodes[id];
    for (const node of Object.values(data.nodes)) node.children = node.children.filter(id => !doomed.has(id));
    if (!data.nodes[data.rootId]) data.rootId = roots(data)[0];
    data.links = (data.links || []).filter(link => data.nodes[link.from] && data.nodes[link.to]);
  }
  // A connector changes a parent-child relationship, so every idea still has
  // one parent. Return a plain-language reason for invalid drop targets.
  function connectionIssue(data, id, target, side) {
    if (!data.nodes[id] || !data.nodes[target]) return 'Choose an existing idea.';
    if (id === target) return 'An idea cannot connect to itself.';
    if (subtree(data, id).includes(target)) return 'This would create a circular branch.';
    const nextSide = data.nodes[target].side || side || data.nodes[id].side;
    if (data.nodes[id].parentId === target && nextSide === data.nodes[id].side) return 'These ideas are already connected.';
    let parentDepth = 0, ancestor = data.nodes[target];
    while (ancestor.parentId) { parentDepth++; ancestor = data.nodes[ancestor.parentId]; }
    const depth = nodeId => 1 + Math.max(0, ...data.nodes[nodeId].children.map(depth));
    if (parentDepth + depth(id) > 100) return 'A map can have up to 100 levels.';
    return null;
  }
  function move(data, id, target, side) {
    if (connectionIssue(data, id, target, side)) return false;
    const node = data.nodes[id], parent = data.nodes[target];
    if (node.parentId !== target) {
      if (node.parentId) data.nodes[node.parentId].children = data.nodes[node.parentId].children.filter(c => c !== id);
      else {
        if (id === data.rootId) { let head = parent; while (head.parentId) head = data.nodes[head.parentId]; data.rootId = head.id; }
        node.connectorType = data.defaultConnectorType || 'line';
      }
      parent.children.push(id);
    }
    node.parentId = target;
    parent.collapsed = false;
    const nextSide = parent.side || side || node.side || 'right';
    subtree(data, id).forEach(c => { data.nodes[c].side = nextSide; });
    return true;
  }

  // A canvas is a forest: several trees, each with one unconnected starting idea.
  function roots(data) {
    return Object.keys(data.nodes).filter(id => data.nodes[id].parentId === null)
      .sort((a,b) => a === data.rootId ? -1 : b === data.rootId ? 1 : 0);
  }
  function detach(data, id, position) {
    const node = data.nodes[id];
    if (!node?.parentId) return false;
    data.nodes[node.parentId].children = data.nodes[node.parentId].children.filter(c => c !== id);
    node.parentId = null; node.side = null;
    node.x = position.x; node.y = position.y;
    return true;
  }
  function addRoot(data, position) {
    const id = uid();
    data.nodes[id] = { id, text: '', parentId: null, children: [], side: null,
      size: 'title', color: 'default', collapsed: false, x: position.x, y: position.y };
    return id;
  }
  // Extra links describe relationships, including feedback. They never change
  // the parent/child outline, so loops cannot trap keyboard navigation or export.
  function checkedText(value, limit, label) {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > limit) throw new Error(`${label} exceeds its text limit or is invalid.`);
    return value;
  }
  function edgeFields(record, fallback = 'soft-s') {
    return {connectorType: ['line','arrow','both'].includes(record.connectorType) ? record.connectorType : 'line',
      connectorStyle: ['straight','soft-s','strict-s'].includes(record.connectorStyle) ? record.connectorStyle : fallback || 'soft-s',
      connectorLabel: checkedText(record.connectorLabel,120,'Connector label'),
      connectorDashed: Boolean(record.connectorDashed), connectorReverse: Boolean(record.connectorReverse)};
  }
  function validateLinks(links, nodes, style) {
    if (links === undefined) return [];
    if (!Array.isArray(links) || links.length > 4000) throw new Error('A canvas can contain up to 4,000 extra links.');
    const ids = new Set(Object.keys(nodes));
    return links.map(link => {
      if (!link || !safeID(link.id) || ids.has(link.id) || !own(nodes,link.from) || !own(nodes,link.to)) throw new Error('An extra link has an invalid identity or missing idea.');
      ids.add(link.id); return {id:link.id,from:link.from,to:link.to,...edgeFields(link,style)};
    });
  }
  function edges(data) {
    return [...Object.values(data.nodes).filter(n=>n.parentId).map(n=>({id:n.id,from:n.parentId,to:n.id,record:n,extra:false})),
      ...(data.links||[]).map(link=>({id:link.id,from:link.from,to:link.to,record:link,extra:true}))];
  }
  function edge(data,id) { return edges(data).find(e=>e.id===id); }
  function addLink(data,from,to) {
    if (!data.nodes[from] || !data.nodes[to]) throw new Error('Choose two existing ideas.');
    if ((data.links||[]).length >= 4000) throw new Error('This canvas has reached the 4,000-link limit.');
    const link = {id:uid(),from,to,...edgeFields({connectorType:data.defaultConnectorType||'arrow'},data.connectorStyle)};
    (data.links ||= []).push(link); return link.id;
  }
  function setConnectorType(data,id,type,all=false) {
    const chosen=edge(data,id); if (!chosen || !['line','arrow','both'].includes(type)) return;
    data.defaultConnectorType=type;
    for(const e of edges(data)) if(all||e.id===id)e.record.connectorType=type;
  }
  function setEdgeStyle(data,id,style,all=false) {
    if(!['straight','soft-s','strict-s'].includes(style))return;
    data.connectorStyle=style;
    for(const e of edges(data))if(all||e.id===id)e.record.connectorStyle=style;
  }
  function arrowPoints(x,y,angle) {
    const ux=Math.cos(angle),uy=Math.sin(angle);
    return [[x,y],[x-ux*12-uy*5,y-uy*12+ux*5],[x-ux*12+uy*5,y-uy*12-ux*5]];
  }
  // Shared geometry keeps screen, PDF and SVG arrows and labels in agreement.
  // Feedback curves run outside boxes; self-links use an explicit outside loop.
  function connectorGeometry(parent,child,node,style,extra=false,free=false,lane=0) {
    style=node.connectorStyle||style;
    if(node.connectorReverse)[parent,child]=[child,parent];
    const arrow=node.connectorType==='arrow'||node.connectorType==='both',both=node.connectorType==='both';
    let start,end,c1,c2,path,label,angle,startAngle,extent;
    const same=parent.id===child.id,loop=same || extra && style!=='straight';
    if(loop){
      const top=Math.min(parent.y-parent.height/2,child.y-child.height/2)-75-lane*24;
      start={x:parent.x+(same?parent.width/2+(both?12:0):0),y:parent.y-(same?0:parent.height/2+(both?12:0))};
      end={x:child.x,y:child.y-child.height/2-(arrow?12:0)};
      c1={x:same?parent.x+parent.width/2+90:start.x,y:top};c2={x:end.x,y:top};
      path=style==='strict-s'||style==='straight'?`M ${start.x} ${start.y} H ${c1.x} V ${top} H ${end.x} V ${end.y}`:`M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
      label={x:(start.x+end.x)/2,y:style==='soft-s'?(start.y+end.y)/8+top*.75:top};angle=Math.PI/2;startAngle=same?Math.PI:Math.PI/2;
      if(style==='soft-s') {angle=Math.atan2(end.y-c2.y,end.x-c2.x);startAngle=Math.atan2(start.y-c1.y,start.x-c1.x);}
    } else {
      const dx=child.x-parent.x,dy=child.y-parent.y;
      const vertical=(free||extra)&&Math.abs(dy)>Math.abs(dx);
      const sign=vertical?(dy<0?-1:1):(free||extra||node.connectorReverse?dx<0?-1:1:node.side==='left'?-1:1);
      start=vertical?{x:parent.x,y:parent.y+sign*(parent.height/2+(both?12:0))}:{x:parent.x+sign*(parent.width/2+(both?12:0)),y:parent.y};
      end=vertical?{x:child.x,y:child.y-sign*(child.height/2+(arrow?12:0))}:{x:child.x-sign*(child.width/2+(arrow?12:0)),y:child.y};
      const mid=vertical?(start.y+end.y)/2:(start.x+end.x)/2;
      c1=vertical?{x:start.x,y:mid}:{x:mid,y:start.y};c2=vertical?{x:end.x,y:mid}:{x:mid,y:end.y};
      path=style==='straight'?`M ${start.x} ${start.y} L ${end.x} ${end.y}`:style==='strict-s'?`M ${start.x} ${start.y} L ${c1.x} ${c1.y} L ${c2.x} ${c2.y} L ${end.x} ${end.y}`:`M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
      label={x:(start.x+end.x)/2,y:(start.y+end.y)/2};
      angle=style==='straight'?Math.atan2(end.y-start.y,end.x-start.x):vertical?sign*Math.PI/2:sign===1?0:Math.PI;startAngle=angle+Math.PI;
    }
    extent=[start,end,c1,c2];
    return {path,label,extent,points:arrow?arrowPoints(end.x,end.y,angle):[],startPoints:both?arrowPoints(start.x,start.y,startAngle):[]};
  }
  function diagramEdges(data,boxes) {
    return edges(data).filter(e=>boxes[e.from]&&boxes[e.to]).map((e,i)=>({...e,
      shape:connectorGeometry(boxes[e.from],boxes[e.to],e.record,data.connectorStyle,e.extra,data.layoutMode==='free',e.extra?i%3:0)}));
  }
  function sceneBounds(data,boxes,measure) {
    const b=bounds(boxes);
    for(const {shape,record} of diagramEdges(data,boxes)) {
      for(const p of shape.extent){b.left=Math.min(b.left,p.x);b.right=Math.max(b.right,p.x);b.top=Math.min(b.top,p.y);b.bottom=Math.max(b.bottom,p.y);}
      if(record.connectorLabel){const width=measure?measure(record.connectorLabel,12):record.connectorLabel.length*12;b.left=Math.min(b.left,shape.label.x-width/2);b.right=Math.max(b.right,shape.label.x+width/2);b.top=Math.min(b.top,shape.label.y-18);}
    } return b;
  }
  function duplicateBranch(data,id,boxes) {
    const ids=subtree(data,id),mapping=Object.fromEntries(ids.map(old=>[old,uid()]));
    const bottom=bounds(Object.fromEntries(ids.filter(i=>boxes[i]).map(i=>[i,boxes[i]]))).bottom;
    for(const old of ids){const n=clone(data.nodes[old]);n.id=mapping[old];n.parentId=old===id?null:mapping[n.parentId];n.children=n.children.map(c=>mapping[c]);if(old===id)n.side=null;
      n.x=(boxes[old]?.x||0)+60;n.y=(boxes[old]?.y||0)+bottom-(boxes[id]?.y||0)+160;
      data.nodes[n.id]=n;
    }
    for(const link of [...data.links||[]])if(mapping[link.from]&&mapping[link.to])data.links.push({...clone(link),id:uid(),from:mapping[link.from],to:mapping[link.to]});
    return mapping[id];
  }
  // Indented lines become children. Parse first, so malformed or oversized input
  // never leaves a half-created outline in the current document.
  function pasteOutline(data,parent,text) {
    if(typeof text!=='string'||text.length>200000)throw new Error('Paste an outline under 200,000 characters.');
    const lines=text.split(/\r?\n/).filter(line=>line.trim());
    if(!lines.length)throw new Error('Paste at least one idea.');
    if(Object.keys(data.nodes).length+lines.length>2000)throw new Error('This outline would exceed 2,000 ideas.');
    const stack=[{indent:-1,id:parent}],created=[];
    for(const line of lines){const indent=line.match(/^\s*/)[0].replace(/\t/g,'  ').length;
      while(stack.length>1&&indent<=stack.at(-1).indent)stack.pop();
      if(stack.length>100)throw new Error('The outline is too deeply nested.');
      const id=add(data,stack.at(-1).id);data.nodes[id].text=line.trim().replace(/^(?:[-*+] |\d+[.)] )/,'');
      if(data.nodes[id].text.length>20000)throw new Error('One idea exceeds 20,000 characters.');
      created.push(id);stack.push({indent,id});
    } return created;
  }
  function arrange(data,kind,measure,measureNode=metrics) {
    const boxes=layout(data,measure,true,measureNode);
    if(kind==='tree'){data.layoutMode='tree';return;}
    data.layoutMode='free';
    if(kind==='free'){for(const [id,b]of Object.entries(boxes))Object.assign(data.nodes[id],{x:b.x,y:b.y});return;}
    let cursor=0;
    if(kind==='timeline'){
      for(const root of roots(data))for(const id of subtree(data,root)){data.nodes[id].x=cursor+boxes[id].width/2;data.nodes[id].y=0;cursor+=boxes[id].width+100;}return;
    }
    // Lay out each depth in its own row/column, with subtree space shared by its children.
    const vertical=kind==='vertical',span={},depthSize={};
    function size(id,depth){const b=boxes[id],kids=data.nodes[id].children;
      depthSize[depth]=Math.max(depthSize[depth]||0,vertical?b.height:b.width);
      span[id]=Math.max(vertical?b.width:b.height,kids.reduce((sum,c)=>sum+size(c,depth+1),0)+Math.max(0,kids.length-1)*45);return span[id];}
    roots(data).forEach(id=>size(id,0));const depthAt=[0];
    for(let i=1;i<Object.keys(depthSize).length;i++)depthAt[i]=depthAt[i-1]+depthSize[i-1]/2+100+depthSize[i]/2;
    function place(id,depth,across){const n=data.nodes[id];n.x=vertical?across:depthAt[depth];n.y=vertical?depthAt[depth]:across;
      if(n.parentId)n.side='right';let next=across-(n.children.reduce((s,c)=>s+span[c],0)+Math.max(0,n.children.length-1)*45)/2;
      for(const c of n.children){place(c,depth+1,next+span[c]/2);next+=span[c]+45;}}
    for(const id of roots(data)){place(id,0,cursor+span[id]/2);cursor+=span[id]+140;}
  }

  // Width grows gradually with text length. Once it reaches a readable measure,
  // text wraps into more lines and the box grows vertically. No old height is saved.
  const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
  function metrics(node, measure) {
    const font = { title: 21, heading: 16, text: 14 }[node.size] || 14;
    const lineHeight = Math.ceil(font * 1.45);
    // Export needs visible spacing and whole emoji, not split Unicode pieces.
    const text = (node.text || (node.parentId === null ? 'Central idea' : 'New idea')).replace(/\t/g, '        ');
    const natural = Math.max(...text.split('\n').map(p => measure(p, font)), 40);
    const width = Math.ceil(Math.min(320, Math.max(node.size === 'title' ? 160 : 112, Math.sqrt(natural * lineHeight * 3.6) + 38, Math.min(natural + 38, 180))));
    const limit = width - 38;
    const lines = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      // Break long words as well as ordinary prose, including a first long word.
      for (const token of paragraph.match(/\s+|\S+/gu) || ['']) {
        if (/\S/u.test(token) && line && measure(token, font) <= limit && measure(line + token, font) > limit) { lines.push(line); line = ''; }
        const characters = typeof Intl.Segmenter === 'function' ? Array.from(graphemes.segment(token), part => part.segment) : Array.from(token);
        for (const char of characters) {
          if (line && measure(line + char, font) > limit) { lines.push(line); line = ''; }
          line += char;
        }
      }
      lines.push(line);
    }
    return { width, height: Math.max(52, lines.length * lineHeight + 28), font, lineHeight, lines };
  }

  function layout(data, measure, includeCollapsed = false, measureNode = metrics) {
    const boxes = {}, heights = {};
    const children = id => !includeCollapsed && data.nodes[id].collapsed ? [] : data.nodes[id].children;
    function size(id) {
      boxes[id] = { ...measureNode(data.nodes[id], measure), id, x: 0, y: 0 };
      const kids = children(id);
      heights[id] = Math.max(boxes[id].height, kids.reduce((h, c) => h + size(c), 0) + Math.max(0, kids.length - 1) * 26);
      return heights[id];
    }
    for (const id of roots(data)) size(id);
    function place(id, x, y, side) {
      const b = boxes[id]; b.x = x; b.y = y;
      const kids = children(id);
      let cursor = y - (kids.reduce((h,c) => h + heights[c], 0) + Math.max(0,kids.length-1)*26) / 2;
      for (const child of kids) {
        place(child, x + side * (b.width / 2 + 64 + boxes[child].width / 2), cursor + heights[child] / 2, side);
        cursor += heights[child] + 26;
      }
    }
    // Each disconnected tree has its own saved starting position. Its children
    // still lay themselves out automatically as text grows or branches change.
    for (const rootId of roots(data)) {
      const root = boxes[rootId], anchor = data.nodes[rootId];
      root.x = anchor.x || 0; root.y = anchor.y || 0;
      for (const side of ['left','right']) {
        const kids = children(rootId).filter(id => data.nodes[id].side === side);
        let y = root.y - (kids.reduce((h,c) => h + heights[c], 0) + Math.max(0,kids.length-1)*26)/2;
        for (const id of kids) {
          place(id, root.x + (side === 'left' ? -1 : 1) * (root.width/2 + 64 + boxes[id].width/2), y + heights[id]/2, side === 'left' ? -1 : 1);
          y += heights[id] + 26;
        }
      }
    }
    if(data.layoutMode==='free')for(const [id,b]of Object.entries(boxes)){b.x=data.nodes[id].x||0;b.y=data.nodes[id].y||0;}
    return boxes;
  }
  function bounds(boxes) {
    const values = Object.values(boxes);
    return { left: Math.min(...values.map(b => b.x-b.width/2)), right: Math.max(...values.map(b => b.x+b.width/2)), top: Math.min(...values.map(b => b.y-b.height/2)), bottom: Math.max(...values.map(b => b.y+b.height/2)) };
  }
  const api = { MAX_LIBRARY_BYTES, byteLength, libraryText, edges, edge, addLink, setEdgeStyle, diagramEdges, sceneBounds, duplicateBranch, pasteOutline, arrange, VERSION, SCHEMA, roots, detach, addRoot, setConnectorType, connectorGeometry, clone, uid, createMap, validateLibrary, add, remove, move, connectionIssue, subtree, metrics, layout, bounds };
  if (typeof module !== 'undefined') module.exports = api;
  scope.Mindmap = api;
})(globalThis);
