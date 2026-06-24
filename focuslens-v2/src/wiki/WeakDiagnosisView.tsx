import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { ExternalLink, LocateFixed, Maximize2, Pencil, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

import type { WikiGraphNodeV2, WikiGraphV2 } from "./types";

type ForceNode = WikiGraphNodeV2 & SimulationNodeDatum & { radius: number; color: string };
type ForceEdge = SimulationLinkDatum<ForceNode> & { type: WikiGraphV2["edges"][number]["type"] };
type Camera = { x: number; y: number; scale: number };

const SUBJECT_COLORS = ["#4f72c9", "#7a67bd", "#3f9587", "#b06c55", "#647b91", "#9a7b42"];

export function WeakDiagnosisView({
  graph,
  subjects,
  subject,
  onSubjectChange,
  onOpenPage,
  onEditPage,
}: {
  graph: WikiGraphV2 | null;
  subjects: string[];
  subject: string;
  onSubjectChange: (subject: string) => void;
  onOpenPage: (pageId: string) => void;
  onEditPage?: (pageId: string) => void;
}) {
  const [scope, setScope] = useState<"global" | "local">("global");
  const [selectedId, setSelectedId] = useState("");
  const [hoveredId, setHoveredId] = useState("");
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const selected = graph?.nodes.find((node) => node.id === selectedId) ?? null;

  return (
    <section className="wiki-diagnosis-view obsidian-graph-view">
      <div className="wiki-diagnosis-toolbar">
        <select aria-label="筛选学科" value={subject} onChange={(event) => onSubjectChange(event.target.value)}>
          <option value="">全部学科</option>
          {subjects.map((item) => <option key={item}>{item}</option>)}
        </select>
        <div className="wiki-mode-switch" aria-label="图谱范围">
          <button type="button" className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}><Maximize2 size={15} />全局图谱</button>
          <button type="button" disabled={!selectedId} className={scope === "local" ? "active" : ""} onClick={() => setScope("local")}><LocateFixed size={15} />局部图谱</button>
        </div>
        <div className="wiki-graph-legend" aria-label="图谱图例">
          <span><i className="legend-dot subject" />学科</span>
          <span><i className="legend-dot chapter" />章节</span>
          <span><i className="legend-dot weak" />薄弱知识</span>
          <span><i className="legend-ring" />红环表示待巩固</span>
        </div>
        <div className="wiki-graph-tools">
          <button type="button" aria-label="放大" onClick={() => setCamera((value) => zoomCamera(value, 1.18))}><ZoomIn size={17} /></button>
          <button type="button" aria-label="缩小" onClick={() => setCamera((value) => zoomCamera(value, 0.84))}><ZoomOut size={17} /></button>
          <button type="button" aria-label="复位" onClick={() => setCamera({ x: 0, y: 0, scale: 1 })}><RotateCcw size={17} /></button>
        </div>
      </div>

      <div className="wiki-diagnosis-layout">
        <ForceGraphCanvas
          graph={graph}
          scope={scope}
          selectedId={selectedId}
          hoveredId={hoveredId}
          camera={camera}
          onCameraChange={setCamera}
          onSelect={(id) => {
            setSelectedId(id);
            if (!id) setScope("global");
          }}
          onHover={setHoveredId}
        />

        <aside className="wiki-action-drawer">
          {selected ? (
            <>
              <span className="eyebrow">{selected.subject}{selected.chapter ? ` · ${selected.chapter}` : ""}</span>
              <h3>{selected.full_title || selected.label}</h3>
              <div className="wiki-node-summary">
                <span>{nodeTypeLabel(selected.type)}</span>
                {selected.type === "knowledge" ? <strong>{selected.evidence_count} 条学习证据</strong> : null}
              </div>
              <ActionBlock title="为什么现在复习" text={selected.why || "该知识点仍需要一次掌握验证。"} />
              <ActionBlock title="最近哪次学习暴露问题" text={selected.recent_evidence || "暂时没有可显示的最近证据。"} />
              <ActionBlock title="下一步怎么做" text={selected.next_action || selected.review_first || "完成一道同型题并记录结果。"} />
              {selected.page_id ? (
                <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                  <button type="button" className="primary-btn" onClick={() => onOpenPage(selected.page_id)}>
                    <ExternalLink size={17} />打开完整知识页
                  </button>
                  {onEditPage && (
                    <button type="button" className="secondary-btn" onClick={() => onEditPage(selected.page_id)}>
                      <Pencil size={17} />编辑知识页
                    </button>
                  )}
                </div>
              ) : null}
            </>
          ) : (
            <div className="wiki-action-empty">
              <LocateFixed size={25} />
              <h3>探索薄弱知识网络</h3>
              <p>拖动节点查看网络如何重新组织。选择知识点后，可以切换到局部图谱，只看它附近的关系。</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function ForceGraphCanvas({
  graph,
  scope,
  selectedId,
  hoveredId,
  camera,
  onCameraChange,
  onSelect,
  onHover,
}: {
  graph: WikiGraphV2 | null;
  scope: "global" | "local";
  selectedId: string;
  hoveredId: string;
  camera: Camera;
  onCameraChange: (camera: Camera) => void;
  onSelect: (id: string) => void;
  onHover: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<ForceNode[]>([]);
  const edgesRef = useRef<ForceEdge[]>([]);
  const cameraRef = useRef(camera);
  const interactionRef = useRef<{ mode: "pan" | "node"; id?: string; x: number; y: number; moved: boolean } | null>(null);
  const renderRef = useRef<() => void>(() => undefined);
  const visibleGraph = useMemo(() => filterGraph(graph, scope, selectedId), [graph, scope, selectedId]);

  useEffect(() => {
    cameraRef.current = camera;
    renderRef.current();
  }, [camera]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const subjectOrder = Array.from(new Set(visibleGraph.nodes.map((node) => node.subject || node.label)));
    const colorMap = new Map(subjectOrder.map((item, index) => [item, SUBJECT_COLORS[index % SUBJECT_COLORS.length]]));
    const prior = new Map(nodesRef.current.map((node) => [node.id, node]));
    const nodes: ForceNode[] = visibleGraph.nodes.map((node, index) => {
      const old = prior.get(node.id);
      const angle = (index / Math.max(visibleGraph.nodes.length, 1)) * Math.PI * 2;
      return {
        ...node,
        x: old?.x ?? Math.cos(angle) * 160,
        y: old?.y ?? Math.sin(angle) * 130,
        vx: old?.vx ?? 0,
        vy: old?.vy ?? 0,
        radius: nodeRadius(node),
        color: colorMap.get(node.subject || node.label) ?? SUBJECT_COLORS[0],
      };
    });
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edges: ForceEdge[] = visibleGraph.edges
      .filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target))
      .map((edge) => ({ ...edge, source: edge.source, target: edge.target }));
    nodesRef.current = nodes;
    edgesRef.current = edges;

    const simulation = forceSimulation(nodes)
      .force("link", forceLink<ForceNode, ForceEdge>(edges).id((node) => node.id).distance((edge) => edgeDistance(edge)).strength(0.58))
      .force("charge", forceManyBody<ForceNode>().strength((node) => node.type === "subject" ? -500 : node.type === "chapter" ? -310 : -170))
      .force("center", forceCenter(0, 0).strength(0.45))
      .force("x", forceX<ForceNode>(0).strength(0.025))
      .force("y", forceY<ForceNode>(0).strength(0.025))
      .force("collide", forceCollide<ForceNode>().radius((node) => node.radius + 22).strength(0.9))
      .alphaDecay(0.035)
      .velocityDecay(0.34)
      .on("tick", () => renderRef.current());

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => renderRef.current());
    resizeObserver?.observe(canvas);
    return () => {
      simulation.stop();
      resizeObserver?.disconnect();
    };
  }, [visibleGraph]);

  useEffect(() => {
    renderRef.current = () => drawGraph(canvasRef.current, nodesRef.current, edgesRef.current, cameraRef.current, selectedId, hoveredId);
    renderRef.current();
  }, [selectedId, hoveredId]);

  const pointerToGraph = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const view = cameraRef.current;
    return {
      x: (event.clientX - rect.left - rect.width / 2 - view.x) / view.scale,
      y: (event.clientY - rect.top - rect.height / 2 - view.y) / view.scale,
    };
  };

  const hitNode = (point: { x: number; y: number }) => {
    return [...nodesRef.current].reverse().find((node) => {
      const dx = point.x - (node.x ?? 0);
      const dy = point.y - (node.y ?? 0);
      return dx * dx + dy * dy <= Math.pow(node.radius + 8, 2);
    });
  };

  return (
    <div className="wiki-force-stage">
      <canvas
        ref={canvasRef}
        aria-label="Obsidian 风格薄弱知识图谱"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const point = pointerToGraph(event);
          const node = hitNode(point);
          interactionRef.current = { mode: node ? "node" : "pan", id: node?.id, x: event.clientX, y: event.clientY, moved: false };
          if (node) {
            node.fx = node.x;
            node.fy = node.y;
          }
        }}
        onPointerMove={(event) => {
          const interaction = interactionRef.current;
          const point = pointerToGraph(event);
          if (!interaction) {
            onHover(hitNode(point)?.id ?? "");
            return;
          }
          const dx = event.clientX - interaction.x;
          const dy = event.clientY - interaction.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) interaction.moved = true;
          if (interaction.mode === "pan") {
            const next = { ...cameraRef.current, x: cameraRef.current.x + dx, y: cameraRef.current.y + dy };
            cameraRef.current = next;
            onCameraChange(next);
          } else {
            const node = nodesRef.current.find((item) => item.id === interaction.id);
            if (node) {
              node.fx = point.x;
              node.fy = point.y;
              renderRef.current();
            }
          }
          interaction.x = event.clientX;
          interaction.y = event.clientY;
        }}
        onPointerUp={(event) => {
          const interaction = interactionRef.current;
          if (interaction?.mode === "node") {
            const node = nodesRef.current.find((item) => item.id === interaction.id);
            if (node) {
              node.fx = null;
              node.fy = null;
            }
            if (!interaction.moved && interaction.id) onSelect(interaction.id);
          } else if (interaction && !interaction.moved) {
            onSelect("");
          }
          interactionRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerLeave={() => onHover("")}
        onWheel={(event) => {
          event.preventDefault();
          const next = zoomCamera(cameraRef.current, event.deltaY < 0 ? 1.1 : 0.9);
          cameraRef.current = next;
          onCameraChange(next);
        }}
      />
      {visibleGraph.nodes.length === 0 ? <p className="empty">暂无需要诊断的知识点。完成学习提问后会在这里形成结构。</p> : null}
      <div className="wiki-force-caption">拖动节点 · 滚轮缩放 · 点击查看详情</div>
    </div>
  );
}

function drawGraph(
  canvas: HTMLCanvasElement | null,
  nodes: ForceNode[],
  edges: ForceEdge[],
  camera: Camera,
  selectedId: string,
  hoveredId: string,
) {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== rect.width * ratio || canvas.height !== rect.height * ratio) {
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  context.save();
  context.translate(rect.width / 2 + camera.x, rect.height / 2 + camera.y);
  context.scale(camera.scale, camera.scale);

  const neighbors = selectedId ? neighborIds(edges, selectedId) : new Set<string>();
  edges.forEach((edge) => {
    const source = edge.source as ForceNode;
    const target = edge.target as ForceNode;
    const active = !selectedId || source.id === selectedId || target.id === selectedId;
    context.beginPath();
    context.moveTo(source.x ?? 0, source.y ?? 0);
    context.lineTo(target.x ?? 0, target.y ?? 0);
    
    if (edge.type === "contains") {
      const isSubjectEdge = source.type === "subject" || target.type === "subject";
      if (isSubjectEdge) {
        context.lineWidth = (active ? 2.5 : 1.2) / camera.scale;
        context.strokeStyle = active ? "rgba(79, 114, 201, 0.7)" : "rgba(79, 114, 201, 0.15)";
      } else {
        context.lineWidth = (active ? 1.6 : 0.8) / camera.scale;
        context.strokeStyle = active ? "rgba(112, 130, 157, 0.5)" : "rgba(150, 164, 184, 0.12)";
      }
    } else {
      context.lineWidth = (active ? 1.05 : 0.7) / camera.scale;
      context.strokeStyle = active ? "rgba(112, 130, 157, .46)" : "rgba(150, 164, 184, .09)";
      if (edge.type === "prerequisite_of") context.setLineDash([4 / camera.scale, 4 / camera.scale]);
    }
    
    context.stroke();
    context.setLineDash([]);
  });

  nodes.forEach((node) => {
    const active = !selectedId || selectedId === node.id || neighbors.has(node.id);
    const selected = selectedId === node.id;
    const hovered = hoveredId === node.id;
    context.globalAlpha = active ? 1 : 0.15;
    context.beginPath();
    context.arc(node.x ?? 0, node.y ?? 0, node.radius, 0, Math.PI * 2);
    const isToOrganize = node.type !== "subject" && (node.chapter === "待整理" || node.chapter === "" || node.label === "待整理");
    if (isToOrganize) {
      context.fillStyle = "#9ba3af"; // Grey fill
    } else {
      context.fillStyle = node.color;
    }
    context.fill();
    
    if (isToOrganize) {
      context.strokeStyle = "rgba(249, 115, 22, 0.85)"; // Orange dashed border
      context.lineWidth = 1.5 / camera.scale;
      context.setLineDash([3 / camera.scale, 3 / camera.scale]);
      context.stroke();
      context.setLineDash([]);
    } else if (node.mastery_state === "weak" || node.mastery_state === "pending_verification") {
      context.strokeStyle = selected ? "#d94848" : "rgba(217, 72, 72, .7)";
      context.lineWidth = (selected ? 3 : 1.5) / camera.scale;
      context.stroke();
    }
    if (hovered || selected) {
      context.beginPath();
      context.arc(node.x ?? 0, node.y ?? 0, node.radius + 5 / camera.scale, 0, Math.PI * 2);
      context.strokeStyle = "rgba(54, 91, 153, .28)";
      context.lineWidth = 4 / camera.scale;
      context.stroke();
    }

    const showLabel = node.type === "subject" || node.type === "chapter" || selected || hovered || camera.scale >= 1.28;
    if (showLabel) drawLabel(context, node, camera.scale, selected || hovered);
  });
  context.globalAlpha = 1;
  context.restore();
}

function drawLabel(context: CanvasRenderingContext2D, node: ForceNode, scale: number, emphasized: boolean) {
  const text = shortLabel(node.label, emphasized ? 18 : node.type === "subject" ? 12 : 10);
  const fontSize = node.type === "subject" ? 15 : node.type === "chapter" ? 12 : emphasized ? 11 : 9;
  context.font = `${node.type === "subject" ? 800 : node.type === "chapter" ? 700 : 500} ${fontSize / scale}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "top";
  const x = node.x ?? 0;
  const y = (node.y ?? 0) + node.radius + 5 / scale;
  if (emphasized) {
    const metrics = context.measureText(text);
    context.fillStyle = "rgba(255, 255, 255, .92)";
    context.fillRect(x - metrics.width / 2 - 4 / scale, y - 2 / scale, metrics.width + 8 / scale, (fontSize + 6) / scale);
  }
  context.fillStyle = node.type === "subject" ? "#0f172a" : node.type === "chapter" ? "#334155" : "#475569";
  context.fillText(text, x, y);
}

function filterGraph(graph: WikiGraphV2 | null, scope: "global" | "local", selectedId: string) {
  if (!graph) return { nodes: [], edges: [] };
  if (scope === "global" || !selectedId) return graph;
  const ids = neighborIds(graph.edges, selectedId);
  ids.add(selectedId);
  graph.edges.forEach((edge) => {
    if (ids.has(edge.source)) ids.add(edge.target);
    if (ids.has(edge.target)) ids.add(edge.source);
  });
  return {
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  };
}

function neighborIds(edges: Array<{ source: string | number | ForceNode; target: string | number | ForceNode }>, id: string) {
  const ids = new Set<string>();
  edges.forEach((edge) => {
    const source = typeof edge.source === "object" ? edge.source.id : String(edge.source);
    const target = typeof edge.target === "object" ? edge.target.id : String(edge.target);
    if (source === id) ids.add(target);
    if (target === id) ids.add(source);
  });
  return ids;
}

function nodeRadius(node: WikiGraphNodeV2) {
  if (node.type === "subject") return 15;
  if (node.type === "chapter") return 9;
  return Math.min(7, 4.0 + Math.sqrt(node.evidence_count) * 1.1);
}

function edgeDistance(edge: ForceEdge) {
  if (edge.type === "contains") {
    const sType = typeof edge.source === "object" ? (edge.source as any).type : "";
    const tType = typeof edge.target === "object" ? (edge.target as any).type : "";
    if (sType === "subject" || tType === "subject") {
      return 55; // Subject to Chapter (tighter trunk)
    }
    return 75; // Chapter to Knowledge
  }
  if (edge.type === "prerequisite_of") return 105;
  return 120;
}


function zoomCamera(camera: Camera, factor: number): Camera {
  return { ...camera, scale: Math.min(2.6, Math.max(0.42, camera.scale * factor)) };
}

function shortLabel(label: string, max = 10) {
  const compact = label.replace(/[_\s]+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function nodeTypeLabel(type: WikiGraphNodeV2["type"]) {
  return { subject: "学科", chapter: "章节", knowledge: "知识点", prerequisite: "前置知识" }[type];
}

function ActionBlock({ title, text }: { title: string; text: string }) {
  return <section className="wiki-v2-info"><strong>{title}</strong><p>{text}</p></section>;
}
