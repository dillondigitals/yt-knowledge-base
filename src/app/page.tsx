"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";

interface Creator {
  id: string;
  name: string;
  handle: string;
  focus: string;
  color: string;
  initials: string;
  photo: string;
}

interface TranscriptEntry {
  videoId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  url: string;
  transcript: string;
  charCount: number;
}

interface CreatorData {
  urls: string[];
  status: "idle" | "processing" | "done" | "error";
  transcripts: number;
  totalChars: number;
  extractedTranscripts: TranscriptEntry[];
}

interface LogEntry {
  time: string;
  msg: string;
  type: "info" | "success" | "complete" | "error";
}

const CREATORS: Creator[] = [
  {
    id: "myron-golden",
    name: "Myron Golden",
    handle: "@myabornceo",
    focus: "Four-level teaching, closing techniques, premium offers, kingdom principles",
    color: "#F0B429",
    initials: "MG",
    photo: "/creators/myron-golden.jpg",
  },
  {
    id: "russell-brunson",
    name: "Russell Brunson",
    handle: "@russellbrunson",
    focus: "Expert Secrets, WHAT vs HOW, pitch structure, funnel architecture",
    color: "#2EC4B6",
    initials: "RB",
    photo: "/creators/russell-brunson.jpg",
  },
  {
    id: "joshua-selman",
    name: "Joshua Selman",
    handle: "@apostlejoshuaselman",
    focus: "Faith-based principles, referenced as 'a mentor told me' in content",
    color: "#E8927C",
    initials: "JS",
    photo: "/creators/joshua-selman.jpg",
  },
  {
    id: "alex-hormozi",
    name: "Alex Hormozi",
    handle: "@AlexHormozi",
    focus: "Value equation, offer stacking, sell the ham not the garlic",
    color: "#A78BFA",
    initials: "AH",
    photo: "/creators/alex-hormozi.webp",
  },
];

const STATUS_ICONS: Record<string, string> = {
  idle: "\u25CB",
  processing: "\u25D4",
  done: "\u25CF",
  error: "\u25CF",
};

function now() {
  return new Date().toLocaleTimeString();
}

export default function KnowledgeBaseApp() {
  const [selectedCreator, setSelectedCreator] = useState<Creator>(CREATORS[0]);
  const [urlInput, setUrlInput] = useState("");
  const [creatorData, setCreatorData] = useState<Record<string, CreatorData>>(
    CREATORS.reduce(
      (acc, c) => ({
        ...acc,
        [c.id]: { urls: [], status: "idle", transcripts: 0, totalChars: 0, extractedTranscripts: [] },
      }),
      {}
    )
  );
  const [activeTab, setActiveTab] = useState<"urls" | "log" | "document" | "chat">("urls");
  const [buildLog, setBuildLog] = useState<LogEntry[]>([]);
  const [isBuilding, setIsBuilding] = useState(false);
  const [authStatus, setAuthStatus] = useState<{ authenticated: boolean; email?: string } | null>(null);
  const [chatMessages, setChatMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatting, setIsChatting] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const currentData = creatorData[selectedCreator.id];

  const generateDocument = useCallback(() => {
    const entries = currentData.extractedTranscripts;
    if (entries.length === 0) return "";
    const header = `# ${selectedCreator.name} — Complete Transcripts\n\nGenerated: ${new Date().toLocaleDateString()}\nTotal Videos: ${entries.length}\nTotal Characters: ${entries.reduce((s, e) => s + e.charCount, 0).toLocaleString()}\n\n---\n\n`;
    const body = entries
      .map(
        (e, i) =>
          `## ${i + 1}. ${e.title}\n\n**Channel:** ${e.channelTitle}\n**Published:** ${e.publishedAt ? new Date(e.publishedAt).toLocaleDateString() : "Unknown"}\n**URL:** ${e.url}\n**Characters:** ${e.charCount.toLocaleString()}\n\n${e.transcript}\n\n---\n\n`
      )
      .join("");
    return header + body;
  }, [currentData.extractedTranscripts, selectedCreator.name]);

  const downloadDocument = useCallback(() => {
    const doc = generateDocument();
    if (!doc) return;
    const blob = new Blob([doc], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedCreator.name} — Complete Transcripts.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [generateDocument, selectedCreator.name]);

  const copyDocument = useCallback(() => {
    const doc = generateDocument();
    if (!doc) return;
    navigator.clipboard.writeText(doc);
  }, [generateDocument]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const sendChat = useCallback(async () => {
    if (!chatInput.trim() || isChatting) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    const newMessages = [...chatMessages, { role: "user" as const, content: userMsg }];
    setChatMessages(newMessages);
    setIsChatting(true);

    // Build transcript context from extracted transcripts
    const entries = currentData.extractedTranscripts;
    let transcriptContext = "";
    if (entries.length > 0) {
      // Include as much as fits in context (truncate if needed)
      for (const e of entries) {
        const block = `\n### ${e.title}\nURL: ${e.url}\n\n${e.transcript}\n\n---\n`;
        if (transcriptContext.length + block.length > 800000) break; // ~200K tokens limit
        transcriptContext += block;
      }
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages,
          creatorName: selectedCreator.name,
          transcriptContext,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        setChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${err.error || "Failed to get response"}` },
        ]);
        setIsChatting(false);
        return;
      }

      // Stream the response
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let assistantMsg = "";
      setChatMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));
          for (const line of lines) {
            const data = line.slice(6);
            if (data === "[DONE]") break;
            try {
              const parsed = JSON.parse(data);
              if (parsed.text) {
                assistantMsg += parsed.text;
                setChatMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = { role: "assistant", content: assistantMsg };
                  return updated;
                });
              }
            } catch {
              continue;
            }
          }
        }
      }
    } catch {
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error: Failed to connect to chat API" },
      ]);
    }
    setIsChatting(false);
  }, [chatInput, chatMessages, isChatting, currentData.extractedTranscripts, selectedCreator.name]);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then(setAuthStatus)
      .catch(() => setAuthStatus({ authenticated: false }));
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [buildLog]);

  const addUrls = () => {
    if (!urlInput.trim()) return;
    const newUrls = urlInput
      .split("\n")
      .map((u) => u.trim())
      .filter(
        (u) =>
          u &&
          (u.includes("youtube.com") || u.includes("youtu.be")) &&
          !currentData.urls.includes(u)
      );
    if (newUrls.length === 0) return;

    setCreatorData((prev) => ({
      ...prev,
      [selectedCreator.id]: {
        ...prev[selectedCreator.id],
        urls: [...prev[selectedCreator.id].urls, ...newUrls],
      },
    }));
    setUrlInput("");
  };

  const removeUrl = (url: string) => {
    setCreatorData((prev) => ({
      ...prev,
      [selectedCreator.id]: {
        ...prev[selectedCreator.id],
        urls: prev[selectedCreator.id].urls.filter((u) => u !== url),
      },
    }));
  };

  const clearUrls = () => {
    setCreatorData((prev) => ({
      ...prev,
      [selectedCreator.id]: {
        ...prev[selectedCreator.id],
        urls: [],
        status: "idle",
        transcripts: 0,
        totalChars: 0,
        extractedTranscripts: [],
      },
    }));
    setBuildLog([]);
  };

  // Fetch the creator's most recent N YouTube videos via /api/channel,
  // populate the URL list, and (optionally) auto-build right after.
  const scanChannel = useCallback(
    async (limit: number = 25, autoBuild: boolean = true) => {
      if (isBuilding) return;
      setActiveTab("log");
      setBuildLog([
        { time: now(), msg: `Scanning ${selectedCreator.name}'s channel (${selectedCreator.handle})…`, type: "info" },
      ]);
      setCreatorData((prev) => ({
        ...prev,
        [selectedCreator.id]: { ...prev[selectedCreator.id], status: "processing" },
      }));
      try {
        const res = await fetch("/api/channel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: selectedCreator.handle }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const allUrls: string[] = data.urls || [];
        const recent = allUrls.slice(0, limit);
        setCreatorData((prev) => ({
          ...prev,
          [selectedCreator.id]: {
            ...prev[selectedCreator.id],
            urls: recent,
            status: "idle",
          },
        }));
        setBuildLog((prev) => [
          ...prev,
          {
            time: now(),
            msg: `Found ${allUrls.length} videos on ${data.channelName || selectedCreator.name}'s channel; queued ${recent.length} most recent.`,
            type: "success",
          },
        ]);
        if (autoBuild && recent.length > 0) {
          // Defer slightly so the URL state update settles
          await new Promise((r) => setTimeout(r, 200));
          buildKnowledgeBase();
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Unknown error";
        setBuildLog((prev) => [...prev, { time: now(), msg: `Scan failed: ${message}`, type: "error" }]);
        setCreatorData((prev) => ({
          ...prev,
          [selectedCreator.id]: { ...prev[selectedCreator.id], status: "error" },
        }));
      }
    },
    // buildKnowledgeBase is defined further down; safe to omit because it's
    // referenced via closure of the current render and React handles re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedCreator, isBuilding]
  );

  const buildKnowledgeBase = useCallback(async () => {
    if (currentData.urls.length === 0 || isBuilding) return;

    setIsBuilding(true);
    setActiveTab("log");
    setBuildLog([]);

    const urls = currentData.urls;
    const creatorId = selectedCreator.id;
    const creatorName = selectedCreator.name;

    setCreatorData((prev) => ({
      ...prev,
      [creatorId]: { ...prev[creatorId], status: "processing", transcripts: 0, totalChars: 0, extractedTranscripts: [] },
    }));

    setBuildLog([
      { time: now(), msg: `Starting transcript extraction for ${creatorName}`, type: "info" },
      { time: now(), msg: `Found ${urls.length} URLs to process`, type: "info" },
    ]);

    let processed = 0;
    let totalChars = 0;
    let hasError = false;

    for (const url of urls) {
      // Small delay between requests to avoid YouTube rate limiting
      if (processed > 0) {
        await new Promise((r) => setTimeout(r, 1500));
      }
      processed++;
      try {
        const res = await fetch("/api/transcript", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, creatorSlug: creatorId }),
        });

        const data = await res.json();

        if (data.error) {
          setBuildLog((prev) => [
            ...prev,
            { time: now(), msg: `[${processed}/${urls.length}] Failed: ${data.error}`, type: "error" },
          ]);
          hasError = true;
        } else {
          const chars = data.transcript?.length || 0;
          totalChars += chars;
          // Store the extracted transcript
          if (data.transcript) {
            setCreatorData((prev) => ({
              ...prev,
              [creatorId]: {
                ...prev[creatorId],
                extractedTranscripts: [
                  ...prev[creatorId].extractedTranscripts,
                  {
                    videoId: data.videoId,
                    title: data.title,
                    channelTitle: data.channelTitle,
                    publishedAt: data.publishedAt,
                    url: data.url,
                    transcript: data.transcript,
                    charCount: chars,
                  },
                ],
              },
            }));
          }
          setBuildLog((prev) => [
            ...prev,
            {
              time: now(),
              msg: `[${processed}/${urls.length}] ${data.title || "Untitled"} \u2014 ${chars.toLocaleString()} chars`,
              type: "success",
            },
          ]);
        }
      } catch {
        setBuildLog((prev) => [
          ...prev,
          { time: now(), msg: `[${processed}/${urls.length}] Network error`, type: "error" },
        ]);
        hasError = true;
      }

      setCreatorData((prev) => ({
        ...prev,
        [creatorId]: {
          ...prev[creatorId],
          transcripts: processed,
          totalChars: totalChars,
        },
      }));
    }

    setBuildLog((prev) => [
      ...prev,
      { time: now(), msg: `All ${urls.length} URLs processed`, type: "info" },
      {
        time: now(),
        msg: hasError
          ? "Completed with some errors"
          : `Total: ${totalChars.toLocaleString()} characters extracted`,
        type: hasError ? "error" : "complete",
      },
    ]);

    setCreatorData((prev) => ({
      ...prev,
      [creatorId]: { ...prev[creatorId], status: hasError ? "error" : "done" },
    }));
    setIsBuilding(false);
  }, [currentData.urls, isBuilding, selectedCreator]);

  const totalUrlsAll = Object.values(creatorData).reduce((s, d) => s + d.urls.length, 0);
  const totalTranscriptsAll = Object.values(creatorData).reduce((s, d) => s + d.transcripts, 0);
  const totalCharsAll = Object.values(creatorData).reduce((s, d) => s + d.totalChars, 0);

  return (
    <div style={{ fontFamily: "var(--font-dm-sans), 'DM Sans', 'Segoe UI', sans-serif", background: "#0B1120", minHeight: "100vh", color: "#C9D1D9" }}>
      {/* Header */}
      <div style={{ borderBottom: "1px solid #1E293B", padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: "linear-gradient(135deg, #2EC4B6, #0F766E)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: 700, color: "#fff" }}>
            KB
          </div>
          <div>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "#F0F6FC", letterSpacing: "-0.01em" }}>
              Knowledge Base Builder
            </div>
            <div style={{ fontSize: "11px", color: "#5A6B7F" }}>
              YouTube Transcript Extraction + Google Docs
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "20px", fontSize: "12px", alignItems: "center" }}>
          {[
            { label: "URLs", value: totalUrlsAll },
            { label: "Transcripts", value: totalTranscriptsAll },
            { label: "Characters", value: totalCharsAll.toLocaleString() },
          ].map((stat) => (
            <div key={stat.label} style={{ textAlign: "center" }}>
              <div style={{ color: "#5A6B7F", marginBottom: "2px" }}>{stat.label}</div>
              <div style={{ color: "#F0F6FC", fontWeight: 700, fontFamily: "var(--font-jetbrains), 'JetBrains Mono', monospace" }}>{stat.value}</div>
            </div>
          ))}
          <div style={{ borderLeft: "1px solid #1E293B", paddingLeft: "16px", marginLeft: "4px" }}>
            {authStatus?.authenticated ? (
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#2EC4B6" }} />
                <span style={{ color: "#8B9CB6", fontSize: "11px" }}>{authStatus.email}</span>
                <button
                  onClick={() => { fetch("/api/auth/logout", { method: "POST" }).then(() => window.location.reload()); }}
                  style={{ background: "none", border: "none", color: "#5A6B7F", fontSize: "11px", cursor: "pointer", textDecoration: "underline" }}
                >
                  Sign out
                </button>
              </div>
            ) : (
              <a
                href="/api/auth/login"
                style={{
                  padding: "6px 12px", borderRadius: "6px", border: "1px solid #1E293B",
                  background: "#151D2E", color: "#C9D1D9", fontSize: "11px", fontWeight: 600,
                  cursor: "pointer", textDecoration: "none",
                }}
              >
                Sign in with Google
              </a>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 65px)" }}>
        {/* Sidebar */}
        <div style={{ width: "260px", borderRight: "1px solid #1E293B", padding: "16px 12px", flexShrink: 0 }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: "#5A6B7F", textTransform: "uppercase", letterSpacing: "0.08em", padding: "0 8px", marginBottom: "12px" }}>
            Content Creators
          </div>

          {CREATORS.map((creator) => {
            const data = creatorData[creator.id];
            const isActive = selectedCreator.id === creator.id;

            return (
              <button
                key={creator.id}
                onClick={() => { setSelectedCreator(creator); setBuildLog([]); }}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: "10px",
                  padding: "10px 8px", marginBottom: "4px", border: "1px solid transparent",
                  borderRadius: "8px", background: isActive ? "#151D2E" : "transparent",
                  borderColor: isActive ? "#1E293B" : "transparent", cursor: "pointer", textAlign: "left",
                  transition: "all 0.15s ease",
                }}
              >
                <div style={{
                  width: "36px", height: "36px", borderRadius: "8px",
                  background: `${creator.color}18`, border: `1px solid ${creator.color}30`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "12px", fontWeight: 700, color: creator.color, flexShrink: 0, overflow: "hidden",
                }}>
                  <Image src={creator.photo} alt={creator.name} width={36} height={36} style={{ objectFit: "cover", width: "100%", height: "100%" }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: isActive ? "#F0F6FC" : "#8B9CB6" }}>
                    {creator.name}
                  </div>
                  <div style={{ fontSize: "11px", color: "#5A6B7F", display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ color: data.status === "done" ? "#2EC4B6" : data.status === "processing" ? "#F0B429" : data.status === "error" ? "#F87171" : "#5A6B7F" }}>
                      {STATUS_ICONS[data.status]}
                    </span>
                    {data.urls.length} URLs
                    {data.transcripts > 0 && ` \u00B7 ${data.transcripts} done`}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Main Content */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          {/* Creator Header */}
          <div style={{ padding: "20px 24px", borderBottom: "1px solid #1E293B", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <div style={{
                width: "44px", height: "44px", borderRadius: "10px",
                background: `${selectedCreator.color}18`, border: `1.5px solid ${selectedCreator.color}40`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "16px", fontWeight: 700, color: selectedCreator.color, overflow: "hidden",
              }}>
                <Image src={selectedCreator.photo} alt={selectedCreator.name} width={44} height={44} style={{ objectFit: "cover", width: "100%", height: "100%" }} />
              </div>
              <div>
                <div style={{ fontSize: "18px", fontWeight: 700, color: "#F0F6FC", letterSpacing: "-0.01em" }}>
                  {selectedCreator.name}
                </div>
                <div style={{ fontSize: "12px", color: "#5A6B7F" }}>{selectedCreator.focus}</div>
              </div>
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={() => scanChannel(25, true)}
              disabled={isBuilding}
              title={`Scan ${selectedCreator.name}'s most recent 25 videos and extract transcripts to Drive`}
              style={{
                padding: "10px 16px", borderRadius: "8px",
                border: `1px solid ${selectedCreator.color}50`,
                background: "transparent",
                color: isBuilding ? "#5A6B7F" : selectedCreator.color,
                fontSize: "13px", fontWeight: 600,
                cursor: isBuilding ? "not-allowed" : "pointer",
                transition: "all 0.15s ease",
              }}
            >
              {isBuilding ? "…" : `🔄 Scan ${selectedCreator.name.split(" ")[0]}'s channel`}
            </button>
            <button
              onClick={buildKnowledgeBase}
              disabled={currentData.urls.length === 0 || isBuilding}
              style={{
                padding: "10px 20px", borderRadius: "8px", border: "none",
                background: currentData.urls.length === 0 || isBuilding ? "#1E293B" : selectedCreator.color,
                color: currentData.urls.length === 0 || isBuilding ? "#5A6B7F" : "#0B1120",
                fontSize: "13px", fontWeight: 700,
                cursor: currentData.urls.length === 0 || isBuilding ? "not-allowed" : "pointer",
                transition: "all 0.15s ease",
              }}
              className={isBuilding ? "animate-pulse-border" : ""}
            >
              {isBuilding
                ? `Extracting ${currentData.transcripts}/${currentData.urls.length}...`
                : currentData.status === "done"
                ? "Rebuild Knowledge Base"
                : "Build Knowledge Base"}
            </button>
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: "0", borderBottom: "1px solid #1E293B" }}>
            {(["urls", "log", "document", "chat"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: "10px 20px", border: "none",
                  borderBottom: activeTab === tab ? `2px solid ${selectedCreator.color}` : "2px solid transparent",
                  background: "transparent",
                  color: activeTab === tab ? "#F0F6FC" : "#5A6B7F",
                  fontSize: "12px", fontWeight: 600, cursor: "pointer",
                  textTransform: "uppercase", letterSpacing: "0.05em",
                }}
              >
                {tab === "urls" ? `URLs (${currentData.urls.length})` : tab === "log" ? "Build Log" : tab === "document" ? `Document (${currentData.extractedTranscripts.length})` : "Chat"}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div style={{ flex: 1, overflow: "auto" }}>
            {activeTab === "urls" ? (
              <div style={{ padding: "20px 24px" }}>
                {/* URL Input */}
                <div style={{ marginBottom: "20px" }}>
                  <div style={{ fontSize: "11px", fontWeight: 600, color: "#5A6B7F", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "8px" }}>
                    Paste YouTube URLs (one per line)
                  </div>
                  <textarea
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder={`https://www.youtube.com/watch?v=...\nhttps://www.youtube.com/watch?v=...\nhttps://www.youtube.com/watch?v=...`}
                    rows={5}
                    style={{
                      width: "100%", padding: "12px 14px", border: "1px solid #1E293B",
                      borderRadius: "8px", background: "#0D1525", color: "#C9D1D9",
                      fontSize: "13px", fontFamily: "var(--font-jetbrains), 'JetBrains Mono', monospace",
                      lineHeight: "1.6", resize: "vertical",
                    }}
                  />
                  <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
                    <button
                      onClick={addUrls}
                      style={{
                        padding: "8px 16px", borderRadius: "6px",
                        border: `1px solid ${selectedCreator.color}40`,
                        background: `${selectedCreator.color}15`, color: selectedCreator.color,
                        fontSize: "12px", fontWeight: 600, cursor: "pointer",
                      }}
                    >
                      + Add URLs
                    </button>
                    {currentData.urls.length > 0 && (
                      <button
                        onClick={clearUrls}
                        style={{
                          padding: "8px 16px", borderRadius: "6px",
                          border: "1px solid #2A1215", background: "#1A0A0D",
                          color: "#F87171", fontSize: "12px", fontWeight: 600, cursor: "pointer",
                        }}
                      >
                        Clear All
                      </button>
                    )}
                  </div>
                </div>

                {/* URL List */}
                {currentData.urls.length > 0 ? (
                  <div>
                    <div style={{ fontSize: "11px", fontWeight: 600, color: "#5A6B7F", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "10px" }}>
                      {currentData.urls.length} URLs queued for {selectedCreator.name}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      {currentData.urls.map((url, i) => (
                        <div
                          key={i}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            padding: "8px 12px", borderRadius: "6px", background: "#0D1525", border: "1px solid #1E293B",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: "11px", fontFamily: "var(--font-jetbrains), monospace", color: "#5A6B7F", flexShrink: 0 }}>
                              {String(i + 1).padStart(3, "0")}
                            </span>
                            <span style={{ fontSize: "12px", fontFamily: "var(--font-jetbrains), monospace", color: "#8B9CB6", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {url}
                            </span>
                          </div>
                          <button
                            onClick={() => removeUrl(url)}
                            style={{ background: "none", border: "none", color: "#5A6B7F", cursor: "pointer", fontSize: "14px", padding: "2px 6px", flexShrink: 0 }}
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: "center", padding: "48px 20px", color: "#3A4A5F" }}>
                    <div style={{ fontSize: "32px", marginBottom: "12px" }}>{selectedCreator.initials}</div>
                    <div style={{ fontSize: "14px", fontWeight: 500 }}>No URLs added yet for {selectedCreator.name}</div>
                    <div style={{ fontSize: "12px", marginTop: "6px", color: "#2A3A4F" }}>
                      Paste YouTube URLs above to start building the knowledge base
                    </div>
                  </div>
                )}
              </div>
            ) : activeTab === "log" ? (
              /* Build Log */
              <div style={{ padding: "16px 24px", fontFamily: "var(--font-jetbrains), 'JetBrains Mono', monospace", fontSize: "12px", lineHeight: "1.8" }}>
                {buildLog.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "48px 20px", color: "#3A4A5F" }}>
                    <div style={{ fontSize: "14px", fontWeight: 500 }}>No build activity yet</div>
                    <div style={{ fontSize: "12px", marginTop: "6px", color: "#2A3A4F" }}>
                      Click &quot;Build Knowledge Base&quot; to start extracting transcripts
                    </div>
                  </div>
                ) : (
                  buildLog.map((entry, i) => (
                    <div key={i} className="log-entry" style={{ display: "flex", gap: "12px", padding: "3px 0" }}>
                      <span style={{ color: "#3A4A5F", flexShrink: 0 }}>{entry.time}</span>
                      <span style={{
                        color: entry.type === "success" ? "#2EC4B6" : entry.type === "complete" ? "#F0B429" : entry.type === "error" ? "#F87171" : "#8B9CB6",
                      }}>
                        {entry.msg}
                      </span>
                    </div>
                  ))
                )}
                <div ref={logEndRef} />
              </div>
            ) : activeTab === "document" ? (
              <div style={{ padding: "20px 24px" }}>
                {currentData.extractedTranscripts.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "48px 20px", color: "#3A4A5F" }}>
                    <div style={{ fontSize: "14px", fontWeight: 500 }}>No transcripts extracted yet</div>
                    <div style={{ fontSize: "12px", marginTop: "6px", color: "#2A3A4F" }}>
                      Build the knowledge base first, then come here to download or copy
                    </div>
                  </div>
                ) : (
                  <div>
                    <div style={{ display: "flex", gap: "8px", marginBottom: "20px" }}>
                      <button
                        onClick={downloadDocument}
                        style={{
                          padding: "10px 20px", borderRadius: "8px", border: "none",
                          background: selectedCreator.color, color: "#0B1120",
                          fontSize: "13px", fontWeight: 700, cursor: "pointer",
                        }}
                      >
                        Download as Markdown
                      </button>
                      <button
                        onClick={copyDocument}
                        style={{
                          padding: "10px 20px", borderRadius: "8px",
                          border: `1px solid ${selectedCreator.color}40`,
                          background: `${selectedCreator.color}15`, color: selectedCreator.color,
                          fontSize: "13px", fontWeight: 700, cursor: "pointer",
                        }}
                      >
                        Copy to Clipboard
                      </button>
                    </div>
                    <div style={{
                      fontSize: "12px", color: "#5A6B7F", marginBottom: "16px",
                      fontFamily: "var(--font-jetbrains), monospace",
                    }}>
                      {currentData.extractedTranscripts.length} transcripts &middot;{" "}
                      {currentData.extractedTranscripts.reduce((s, e) => s + e.charCount, 0).toLocaleString()} total characters
                    </div>
                    <div style={{
                      background: "#0D1525", border: "1px solid #1E293B", borderRadius: "8px",
                      padding: "16px", maxHeight: "60vh", overflow: "auto",
                      fontFamily: "var(--font-jetbrains), monospace", fontSize: "12px",
                      lineHeight: "1.6", color: "#8B9CB6", whiteSpace: "pre-wrap",
                    }}>
                      {generateDocument()}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Chat Tab */
              <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                <div style={{ flex: 1, overflow: "auto", padding: "20px 24px" }}>
                  {chatMessages.length === 0 ? (
                    <div style={{ textAlign: "center", padding: "48px 20px", color: "#3A4A5F" }}>
                      <div style={{ fontSize: "20px", marginBottom: "8px" }}>{selectedCreator.initials}</div>
                      <div style={{ fontSize: "14px", fontWeight: 500 }}>
                        Chat with {selectedCreator.name}&apos;s Knowledge Base
                      </div>
                      <div style={{ fontSize: "12px", marginTop: "6px", color: "#2A3A4F" }}>
                        {currentData.extractedTranscripts.length > 0
                          ? `${currentData.extractedTranscripts.length} transcripts loaded as context`
                          : "Build the knowledge base first, then chat here"}
                      </div>
                      {currentData.extractedTranscripts.length > 0 && (
                        <div style={{ marginTop: "20px", display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center" }}>
                          {[
                            `What are ${selectedCreator.name}'s core teachings?`,
                            "What does he say about closing sales?",
                            "Summarize the key frameworks across all videos",
                            "What advice does he give about pricing?",
                          ].map((q) => (
                            <button
                              key={q}
                              onClick={() => { setChatInput(q); }}
                              style={{
                                padding: "6px 12px", borderRadius: "6px",
                                border: "1px solid #1E293B", background: "#0D1525",
                                color: "#8B9CB6", fontSize: "11px", cursor: "pointer",
                              }}
                            >
                              {q}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    chatMessages.map((msg, i) => (
                      <div
                        key={i}
                        style={{
                          marginBottom: "16px",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: msg.role === "user" ? "flex-end" : "flex-start",
                        }}
                      >
                        <div style={{ fontSize: "10px", color: "#5A6B7F", marginBottom: "4px", textTransform: "uppercase" }}>
                          {msg.role === "user" ? "You" : selectedCreator.name + " AI"}
                        </div>
                        <div
                          style={{
                            padding: "12px 16px",
                            borderRadius: "12px",
                            maxWidth: "80%",
                            fontSize: "13px",
                            lineHeight: "1.6",
                            background: msg.role === "user" ? `${selectedCreator.color}20` : "#151D2E",
                            border: `1px solid ${msg.role === "user" ? `${selectedCreator.color}30` : "#1E293B"}`,
                            color: "#C9D1D9",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {msg.content || (isChatting ? "..." : "")}
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>
                <div style={{
                  borderTop: "1px solid #1E293B", padding: "12px 24px",
                  display: "flex", gap: "8px",
                }}>
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                    placeholder={currentData.extractedTranscripts.length > 0 ? `Ask about ${selectedCreator.name}'s teachings...` : "Build knowledge base first..."}
                    disabled={currentData.extractedTranscripts.length === 0}
                    style={{
                      flex: 1, padding: "10px 14px", borderRadius: "8px",
                      border: "1px solid #1E293B", background: "#0D1525",
                      color: "#C9D1D9", fontSize: "13px",
                    }}
                  />
                  <button
                    onClick={sendChat}
                    disabled={!chatInput.trim() || isChatting || currentData.extractedTranscripts.length === 0}
                    style={{
                      padding: "10px 20px", borderRadius: "8px", border: "none",
                      background: chatInput.trim() && !isChatting ? selectedCreator.color : "#1E293B",
                      color: chatInput.trim() && !isChatting ? "#0B1120" : "#5A6B7F",
                      fontSize: "13px", fontWeight: 700, cursor: chatInput.trim() && !isChatting ? "pointer" : "not-allowed",
                    }}
                  >
                    {isChatting ? "..." : "Send"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Status Bar */}
          <div style={{
            borderTop: "1px solid #1E293B", padding: "8px 24px", display: "flex",
            justifyContent: "space-between", fontSize: "11px", color: "#3A4A5F",
            fontFamily: "var(--font-jetbrains), 'JetBrains Mono', monospace",
          }}>
            <span>
              {selectedCreator.name} &middot;{" "}
              {currentData.status === "done" ? "Knowledge base built" : currentData.status === "processing" ? "Building..." : "Ready"}
            </span>
            <span>
              {currentData.totalChars > 0 &&
                `${currentData.totalChars.toLocaleString()} chars \u00B7 ${
                  currentData.totalChars > 1200000
                    ? Math.ceil(currentData.totalChars / 1200000) + " docs"
                    : "1 doc"
                }`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
