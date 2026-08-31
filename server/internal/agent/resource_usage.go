package agent

import (
	"os"
	"sort"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

type AgentMemorySnapshot struct {
	Name         string `json:"name"`
	ProcessCount int    `json:"process_count"`
	MemoryBytes  uint64 `json:"memory_bytes"`
	SessionCount int    `json:"session_count"`
}

type MemorySnapshot struct {
	TotalMemoryBytes uint64                `json:"total_memory_bytes"`
	MeasuredAt       time.Time             `json:"measured_at"`
	Agents           []AgentMemorySnapshot `json:"agents"`
}

type processTreeUsage struct {
	count int
	bytes uint64
}

func (p *Pool) MemorySnapshot(refresh bool) MemorySnapshot {
	if p == nil {
		return MemorySnapshot{}
	}
	if refresh {
		p.refreshMemorySnapshot()
	}
	p.memoryMu.RLock()
	snapshot := cloneMemorySnapshot(p.memorySnapshot)
	p.memoryMu.RUnlock()

	sessionCounts := p.agentSessionCounts()
	byName := make(map[string]int, len(snapshot.Agents)+len(sessionCounts))
	for index := range snapshot.Agents {
		byName[snapshot.Agents[index].Name] = index
	}
	for agentName, count := range sessionCounts {
		index, ok := byName[agentName]
		if !ok {
			snapshot.Agents = append(snapshot.Agents, AgentMemorySnapshot{Name: agentName})
			index = len(snapshot.Agents) - 1
			byName[agentName] = index
		}
		snapshot.Agents[index].SessionCount = count
	}
	sort.Slice(snapshot.Agents, func(i, j int) bool {
		return snapshot.Agents[i].Name < snapshot.Agents[j].Name
	})
	return snapshot
}

func (p *Pool) refreshMemorySnapshot() {
	if p == nil {
		return
	}
	p.memoryCollectMu.Lock()
	defer p.memoryCollectMu.Unlock()

	roots := p.agentProcessRoots()
	claimed := make(map[int32]struct{})
	usageByAgent := make(map[string]processTreeUsage)
	agentNames := make([]string, 0, len(roots))
	for agentName := range roots {
		agentNames = append(agentNames, agentName)
	}
	sort.Strings(agentNames)
	for _, agentName := range agentNames {
		pids := roots[agentName]
		sort.Ints(pids)
		usage := usageByAgent[agentName]
		for _, pid := range pids {
			collectProcessTree(int32(pid), claimed, &usage)
		}
		usageByAgent[agentName] = usage
	}

	snapshot := MemorySnapshot{MeasuredAt: time.Now().UTC()}
	selfClaimed := make(map[int32]struct{})
	selfUsage := processTreeUsage{}
	collectSingleProcess(int32(os.Getpid()), selfClaimed, &selfUsage)
	snapshot.TotalMemoryBytes = selfUsage.bytes
	for _, agentName := range agentNames {
		usage := usageByAgent[agentName]
		if usage.count == 0 && usage.bytes == 0 {
			continue
		}
		snapshot.TotalMemoryBytes += usage.bytes
		snapshot.Agents = append(snapshot.Agents, AgentMemorySnapshot{
			Name:         agentName,
			ProcessCount: usage.count,
			MemoryBytes:  usage.bytes,
		})
	}
	p.memoryMu.Lock()
	p.memorySnapshot = snapshot
	p.memoryMu.Unlock()
}

func (p *Pool) agentProcessRoots() map[string][]int {
	roots := make(map[string][]int)
	if p.acp != nil {
		for agentName, pid := range p.acp.ProcessIDs() {
			roots[agentName] = append(roots[agentName], pid)
		}
	}
	if p.codex != nil {
		for agentName, pid := range p.codex.ProcessIDs() {
			roots[agentName] = append(roots[agentName], pid)
		}
	}
	p.mu.Lock()
	for _, entry := range p.sessions {
		if entry == nil || entry.session == nil {
			continue
		}
		provider, ok := entry.session.(interface{ ProcessID() int })
		if !ok {
			continue
		}
		if pid := provider.ProcessID(); pid > 0 {
			roots[entry.agentName] = append(roots[entry.agentName], pid)
		}
	}
	p.mu.Unlock()
	return roots
}

func (p *Pool) agentSessionCounts() map[string]int {
	out := make(map[string]int)
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, entry := range p.sessions {
		if entry == nil {
			continue
		}
		out[entry.agentName]++
	}
	return out
}

func collectProcessTree(pid int32, claimed map[int32]struct{}, usage *processTreeUsage) {
	if pid <= 0 {
		return
	}
	if _, ok := claimed[pid]; ok {
		return
	}
	proc, err := process.NewProcess(pid)
	if err != nil {
		return
	}
	collectSingleProcess(pid, claimed, usage)
	children, err := proc.Children()
	if err != nil {
		return
	}
	for _, child := range children {
		if child != nil {
			collectProcessTree(child.Pid, claimed, usage)
		}
	}
}

func collectSingleProcess(pid int32, claimed map[int32]struct{}, usage *processTreeUsage) {
	if _, ok := claimed[pid]; ok {
		return
	}
	proc, err := process.NewProcess(pid)
	if err != nil {
		return
	}
	claimed[pid] = struct{}{}
	usage.count++
	if info, err := proc.MemoryInfo(); err == nil && info != nil {
		usage.bytes += info.RSS
	}
}

func cloneMemorySnapshot(in MemorySnapshot) MemorySnapshot {
	out := in
	out.Agents = append([]AgentMemorySnapshot(nil), in.Agents...)
	return out
}
