"""
AVA Health Check and Metrics Module
=====================================
Provides health monitoring, metrics collection, and status reporting
for all AVA components.

Features:
- Component health checks
- Performance metrics
- Resource monitoring
- Status aggregation
- HTTP endpoint (optional)

Usage:
    from ava_health import HealthChecker, get_health_status
    
    # Quick status check
    status = get_health_status()
    print(status['overall_status'])
    
    # Full health checker
    checker = HealthChecker()
    report = checker.get_full_report()
"""

import os
import sys
import json
import time
import sqlite3
import psutil
import socket
import asyncio
import threading
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, List, Callable
from dataclasses import dataclass, field, asdict
from enum import Enum
from functools import wraps

# Import AVA components (optional - graceful degradation if not available)
try:
    from ava_logging import get_logger
    logger = get_logger("health")
except ImportError:
    import logging
    logger = logging.getLogger("ava.health")


# =============================================================================
# ENUMS AND DATA CLASSES
# =============================================================================

class HealthStatus(Enum):
    """Health status levels"""
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"
    UNKNOWN = "unknown"


@dataclass
class ComponentHealth:
    """Health status for a single component"""
    name: str
    status: HealthStatus
    message: str = ""
    response_time_ms: float = 0
    details: Dict[str, Any] = field(default_factory=dict)
    last_check: str = field(default_factory=lambda: datetime.now().isoformat())
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status.value,
            "message": self.message,
            "response_time_ms": self.response_time_ms,
            "details": self.details,
            "last_check": self.last_check
        }


@dataclass
class SystemMetrics:
    """System resource metrics"""
    cpu_percent: float
    memory_percent: float
    memory_used_mb: float
    memory_available_mb: float
    disk_percent: float
    disk_used_gb: float
    disk_free_gb: float
    python_version: str
    platform: str
    uptime_seconds: float
    thread_count: int
    open_files: int = 0
    network_connections: int = 0
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# =============================================================================
# METRICS COLLECTOR
# =============================================================================

class MetricsCollector:
    """Collects and tracks performance metrics"""
    
    def __init__(self, max_history: int = 1000):
        self.max_history = max_history
        self._metrics: Dict[str, List[Dict]] = {}
        self._counters: Dict[str, int] = {}
        self._gauges: Dict[str, float] = {}
        self._start_time = time.time()
        self._lock = threading.Lock()
    
    def record_timing(self, name: str, duration_ms: float, tags: Dict[str, str] = None):
        """Record a timing metric"""
        with self._lock:
            if name not in self._metrics:
                self._metrics[name] = []
            
            entry = {
                "timestamp": datetime.now().isoformat(),
                "duration_ms": duration_ms,
                "tags": tags or {}
            }
            
            self._metrics[name].append(entry)
            
            # Trim old entries
            if len(self._metrics[name]) > self.max_history:
                self._metrics[name] = self._metrics[name][-self.max_history:]
    
    def increment_counter(self, name: str, value: int = 1):
        """Increment a counter"""
        with self._lock:
            self._counters[name] = self._counters.get(name, 0) + value
    
    def set_gauge(self, name: str, value: float):
        """Set a gauge value"""
        with self._lock:
            self._gauges[name] = value
    
    def get_timing_stats(self, name: str) -> Dict[str, Any]:
        """Get statistics for a timing metric"""
        with self._lock:
            if name not in self._metrics or not self._metrics[name]:
                return {"count": 0}
            
            durations = [m["duration_ms"] for m in self._metrics[name]]
            
            return {
                "count": len(durations),
                "min_ms": min(durations),
                "max_ms": max(durations),
                "avg_ms": sum(durations) / len(durations),
                "last_ms": durations[-1]
            }
    
    def get_all_stats(self) -> Dict[str, Any]:
        """Get all metrics statistics"""
        with self._lock:
            return {
                "timings": {name: self.get_timing_stats(name) for name in self._metrics},
                "counters": dict(self._counters),
                "gauges": dict(self._gauges),
                "uptime_seconds": time.time() - self._start_time
            }


# Global metrics collector
_metrics = MetricsCollector()


def record_timing(name: str, duration_ms: float, tags: Dict[str, str] = None):
    """Record a timing metric (global function)"""
    _metrics.record_timing(name, duration_ms, tags)


def increment_counter(name: str, value: int = 1):
    """Increment a counter (global function)"""
    _metrics.increment_counter(name, value)


def timed(metric_name: str):
    """Decorator to time function execution"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            try:
                result = func(*args, **kwargs)
                duration = (time.perf_counter() - start) * 1000
                record_timing(metric_name, duration, {"status": "success"})
                return result
            except Exception as e:
                duration = (time.perf_counter() - start) * 1000
                record_timing(metric_name, duration, {"status": "error", "error": str(e)})
                raise
        return wrapper
    return decorator


# =============================================================================
# HEALTH CHECKER
# =============================================================================

class HealthChecker:
    """Main health checking class"""
    
    def __init__(self, integration_dir: Path = None):
        self.integration_dir = integration_dir or Path(__file__).parent
        self._checks: Dict[str, Callable] = {}
        self._last_results: Dict[str, ComponentHealth] = {}
        self._start_time = time.time()
        
        # Register default checks
        self._register_default_checks()
    
    def _register_default_checks(self):
        """Register default health checks"""
        self.register_check("system", self._check_system)
        self.register_check("database", self._check_database)
        self.register_check("api_keys", self._check_api_keys)
        self.register_check("voice_engine", self._check_voice_engine)
        self.register_check("python_worker", self._check_python_worker)
        self.register_check("config_files", self._check_config_files)
    
    def register_check(self, name: str, check_func: Callable):
        """Register a health check function"""
        self._checks[name] = check_func
    
    def _check_system(self) -> ComponentHealth:
        """Check system resources"""
        start = time.perf_counter()
        
        try:
            cpu = psutil.cpu_percent(interval=0.1)
            memory = psutil.virtual_memory()
            disk = psutil.disk_usage("/")
            
            # Determine status based on thresholds
            status = HealthStatus.HEALTHY
            messages = []
            
            if cpu > 90:
                status = HealthStatus.UNHEALTHY
                messages.append(f"CPU critical: {cpu}%")
            elif cpu > 70:
                status = HealthStatus.DEGRADED
                messages.append(f"CPU high: {cpu}%")
            
            if memory.percent > 90:
                status = HealthStatus.UNHEALTHY
                messages.append(f"Memory critical: {memory.percent}%")
            elif memory.percent > 80:
                if status == HealthStatus.HEALTHY:
                    status = HealthStatus.DEGRADED
                messages.append(f"Memory high: {memory.percent}%")
            
            if disk.percent > 95:
                status = HealthStatus.UNHEALTHY
                messages.append(f"Disk critical: {disk.percent}%")
            elif disk.percent > 85:
                if status == HealthStatus.HEALTHY:
                    status = HealthStatus.DEGRADED
                messages.append(f"Disk high: {disk.percent}%")
            
            return ComponentHealth(
                name="system",
                status=status,
                message="; ".join(messages) if messages else "All resources normal",
                response_time_ms=(time.perf_counter() - start) * 1000,
                details={
                    "cpu_percent": cpu,
                    "memory_percent": memory.percent,
                    "memory_available_mb": memory.available / 1024 / 1024,
                    "disk_percent": disk.percent,
                    "disk_free_gb": disk.free / 1024 / 1024 / 1024
                }
            )
        except Exception as e:
            return ComponentHealth(
                name="system",
                status=HealthStatus.UNKNOWN,
                message=f"Check failed: {e}",
                response_time_ms=(time.perf_counter() - start) * 1000
            )
    
    def _check_database(self) -> ComponentHealth:
        """Check database connectivity"""
        start = time.perf_counter()
        
        db_files = [
            ("self_awareness", self.integration_dir / "ava_self_awareness.db"),
            ("passive_learning", self.integration_dir / "ava_passive_learning.db"),
        ]
        
        details = {}
        errors = []
        
        for name, db_path in db_files:
            if db_path.exists():
                try:
                    conn = sqlite3.connect(str(db_path), timeout=5)
                    cursor = conn.cursor()
                    cursor.execute("SELECT 1")
                    cursor.close()
                    conn.close()
                    details[name] = {"status": "ok", "path": str(db_path)}
                except Exception as e:
                    errors.append(f"{name}: {e}")
                    details[name] = {"status": "error", "error": str(e)}
            else:
                details[name] = {"status": "missing", "path": str(db_path)}
        
        if errors:
            status = HealthStatus.UNHEALTHY
            message = "; ".join(errors)
        elif all(d.get("status") == "ok" for d in details.values()):
            status = HealthStatus.HEALTHY
            message = "All databases accessible"
        else:
            status = HealthStatus.DEGRADED
            message = "Some databases missing"
        
        return ComponentHealth(
            name="database",
            status=status,
            message=message,
            response_time_ms=(time.perf_counter() - start) * 1000,
            details=details
        )
    
    def _check_api_keys(self) -> ComponentHealth:
        """Check API key configuration"""
        start = time.perf_counter()
        
        try:
            from ava_secure_keys import KeyManager
            km = KeyManager(integration_dir=self.integration_dir)
            status_report = km.check_security_status()
            
            available = sum(1 for v in status_report.values() if v.get("available"))
            secure = sum(1 for v in status_report.values() if v.get("secure"))
            total = len(status_report)
            
            if available == 0:
                status = HealthStatus.UNHEALTHY
                message = "No API keys configured"
            elif secure < available:
                status = HealthStatus.DEGRADED
                message = f"{available}/{total} keys available, {available - secure} insecure"
            else:
                status = HealthStatus.HEALTHY
                message = f"{available}/{total} keys available, all secure"
            
            return ComponentHealth(
                name="api_keys",
                status=status,
                message=message,
                response_time_ms=(time.perf_counter() - start) * 1000,
                details={
                    "total": total,
                    "available": available,
                    "secure": secure,
                    "keys": {k: v.get("available", False) for k, v in status_report.items()}
                }
            )
        except Exception as e:
            return ComponentHealth(
                name="api_keys",
                status=HealthStatus.UNKNOWN,
                message=f"Check failed: {e}",
                response_time_ms=(time.perf_counter() - start) * 1000
            )
    
    def _check_voice_engine(self) -> ComponentHealth:
        """Check voice engine availability"""
        start = time.perf_counter()
        
        details = {}
        
        # Check for required dependencies
        try:
            import pyaudio
            details["pyaudio"] = "available"
        except ImportError:
            details["pyaudio"] = "missing"
        
        try:
            from faster_whisper import WhisperModel
            details["whisper"] = "available"
        except ImportError:
            details["whisper"] = "missing"
        
        try:
            import edge_tts
            details["edge_tts"] = "available"
        except ImportError:
            details["edge_tts"] = "missing"
        
        # Check voice config
        config_path = self.integration_dir / "ava_voice_config.json"
        if config_path.exists():
            details["config"] = "present"
        else:
            details["config"] = "missing"
        
        missing = [k for k, v in details.items() if v == "missing"]
        
        if len(missing) >= 2:
            status = HealthStatus.UNHEALTHY
            message = f"Missing: {', '.join(missing)}"
        elif missing:
            status = HealthStatus.DEGRADED
            message = f"Missing optional: {', '.join(missing)}"
        else:
            status = HealthStatus.HEALTHY
            message = "Voice engine ready"
        
        return ComponentHealth(
            name="voice_engine",
            status=status,
            message=message,
            response_time_ms=(time.perf_counter() - start) * 1000,
            details=details
        )
    
    def _check_python_worker(self) -> ComponentHealth:
        """Check Python worker status"""
        start = time.perf_counter()
        
        worker_path = self.integration_dir / "ava_python_worker.py"
        
        if not worker_path.exists():
            return ComponentHealth(
                name="python_worker",
                status=HealthStatus.UNHEALTHY,
                message="Worker script not found",
                response_time_ms=(time.perf_counter() - start) * 1000
            )
        
        # Check syntax
        try:
            import py_compile
            py_compile.compile(str(worker_path), doraise=True)
            
            return ComponentHealth(
                name="python_worker",
                status=HealthStatus.HEALTHY,
                message="Worker script valid",
                response_time_ms=(time.perf_counter() - start) * 1000,
                details={"path": str(worker_path)}
            )
        except py_compile.PyCompileError as e:
            return ComponentHealth(
                name="python_worker",
                status=HealthStatus.UNHEALTHY,
                message=f"Syntax error: {e}",
                response_time_ms=(time.perf_counter() - start) * 1000
            )
    
    def _check_config_files(self) -> ComponentHealth:
        """Check configuration files"""
        start = time.perf_counter()
        
        config_files = [
            ("voice_config", "ava_voice_config.json"),
            ("identity", "ava_identity.json"),
        ]
        
        details = {}
        errors = []
        
        for name, filename in config_files:
            path = self.integration_dir / filename
            if path.exists():
                try:
                    with open(path, 'r') as f:
                        json.load(f)
                    details[name] = "valid"
                except json.JSONDecodeError as e:
                    errors.append(f"{name}: invalid JSON")
                    details[name] = f"invalid: {e}"
            else:
                details[name] = "missing"
        
        if errors:
            status = HealthStatus.UNHEALTHY
            message = "; ".join(errors)
        elif all(v == "valid" for v in details.values()):
            status = HealthStatus.HEALTHY
            message = "All config files valid"
        else:
            status = HealthStatus.DEGRADED
            message = "Some config files missing"
        
        return ComponentHealth(
            name="config_files",
            status=status,
            message=message,
            response_time_ms=(time.perf_counter() - start) * 1000,
            details=details
        )
    
    def run_check(self, name: str) -> ComponentHealth:
        """Run a specific health check"""
        if name not in self._checks:
            return ComponentHealth(
                name=name,
                status=HealthStatus.UNKNOWN,
                message=f"Unknown check: {name}"
            )
        
        try:
            result = self._checks[name]()
            self._last_results[name] = result
            return result
        except Exception as e:
            logger.error(f"Health check '{name}' failed: {e}")
            return ComponentHealth(
                name=name,
                status=HealthStatus.UNKNOWN,
                message=f"Check failed: {e}"
            )
    
    def run_all_checks(self) -> Dict[str, ComponentHealth]:
        """Run all registered health checks"""
        results = {}
        for name in self._checks:
            results[name] = self.run_check(name)
        return results
    
    def get_overall_status(self) -> HealthStatus:
        """Get the overall system health status"""
        results = self.run_all_checks()
        
        if any(r.status == HealthStatus.UNHEALTHY for r in results.values()):
            return HealthStatus.UNHEALTHY
        if any(r.status == HealthStatus.DEGRADED for r in results.values()):
            return HealthStatus.DEGRADED
        if any(r.status == HealthStatus.UNKNOWN for r in results.values()):
            return HealthStatus.DEGRADED
        return HealthStatus.HEALTHY
    
    def get_system_metrics(self) -> SystemMetrics:
        """Get current system metrics"""
        try:
            cpu = psutil.cpu_percent(interval=0.1)
            memory = psutil.virtual_memory()
            disk = psutil.disk_usage("/")
            process = psutil.Process()
            
            return SystemMetrics(
                cpu_percent=cpu,
                memory_percent=memory.percent,
                memory_used_mb=memory.used / 1024 / 1024,
                memory_available_mb=memory.available / 1024 / 1024,
                disk_percent=disk.percent,
                disk_used_gb=disk.used / 1024 / 1024 / 1024,
                disk_free_gb=disk.free / 1024 / 1024 / 1024,
                python_version=sys.version.split()[0],
                platform=sys.platform,
                uptime_seconds=time.time() - self._start_time,
                thread_count=threading.active_count(),
                open_files=len(process.open_files()) if hasattr(process, 'open_files') else 0,
                network_connections=len(process.net_connections()) if hasattr(process, 'net_connections') else 0
            )
        except Exception as e:
            logger.error(f"Failed to get system metrics: {e}")
            return SystemMetrics(
                cpu_percent=0,
                memory_percent=0,
                memory_used_mb=0,
                memory_available_mb=0,
                disk_percent=0,
                disk_used_gb=0,
                disk_free_gb=0,
                python_version=sys.version.split()[0],
                platform=sys.platform,
                uptime_seconds=time.time() - self._start_time,
                thread_count=threading.active_count()
            )
    
    def get_full_report(self) -> Dict[str, Any]:
        """Get a full health report"""
        checks = self.run_all_checks()
        metrics = self.get_system_metrics()
        overall = self.get_overall_status()
        
        return {
            "status": overall.value,
            "timestamp": datetime.now().isoformat(),
            "uptime_seconds": time.time() - self._start_time,
            "checks": {name: check.to_dict() for name, check in checks.items()},
            "metrics": metrics.to_dict(),
            "performance": _metrics.get_all_stats()
        }


# =============================================================================
# CONVENIENCE FUNCTIONS
# =============================================================================

# Global health checker instance
_checker: Optional[HealthChecker] = None


def get_health_checker() -> HealthChecker:
    """Get the global health checker instance"""
    global _checker
    if _checker is None:
        _checker = HealthChecker()
    return _checker


def get_health_status() -> Dict[str, Any]:
    """Get current health status (convenience function)"""
    return get_health_checker().get_full_report()


def check_component(name: str) -> ComponentHealth:
    """Check a specific component's health"""
    return get_health_checker().run_check(name)


def is_healthy() -> bool:
    """Quick check if system is healthy"""
    return get_health_checker().get_overall_status() == HealthStatus.HEALTHY


# =============================================================================
# HTTP SERVER (Optional)
# =============================================================================

def start_health_server(port: int = 8081, host: str = "127.0.0.1"):
    """Start a simple HTTP health server"""
    from http.server import HTTPServer, BaseHTTPRequestHandler
    import json
    
    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/health":
                report = get_health_status()
                status_code = 200 if report["status"] == "healthy" else 503
                
                self.send_response(status_code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(report, indent=2).encode())
            
            elif self.path == "/health/live":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "alive": True,
                    "timestamp": datetime.now().isoformat()
                }).encode())
            
            elif self.path == "/health/ready":
                checker = get_health_checker()
                ready = checker.get_overall_status() != HealthStatus.UNHEALTHY
                
                self.send_response(200 if ready else 503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ready": ready,
                    "timestamp": datetime.now().isoformat()
                }).encode())
            
            elif self.path == "/metrics":
                metrics = _metrics.get_all_stats()
                system = get_health_checker().get_system_metrics()
                
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "performance": metrics,
                    "system": system.to_dict(),
                    "timestamp": datetime.now().isoformat()
                }, indent=2).encode())
            
            else:
                self.send_response(404)
                self.end_headers()
        
        def log_message(self, format, *args):
            # Suppress default logging
            pass
    
    server = HTTPServer((host, port), HealthHandler)
    logger.info(f"Health server starting on http://{host}:{port}")
    
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    
    return server


# =============================================================================
# CLI
# =============================================================================

def main():
    """CLI for health checks"""
    import argparse
    
    parser = argparse.ArgumentParser(description="AVA Health Check")
    parser.add_argument("command", choices=["status", "check", "metrics", "server"], 
                       help="Command to run")
    parser.add_argument("--component", "-c", help="Component to check")
    parser.add_argument("--port", "-p", type=int, default=8081, help="Server port")
    parser.add_argument("--json", "-j", action="store_true", help="JSON output")
    
    args = parser.parse_args()
    
    checker = get_health_checker()
    
    if args.command == "status":
        report = checker.get_full_report()
        
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print(f"\n🏥 AVA Health Status: {report['status'].upper()}")
            print(f"   Uptime: {report['uptime_seconds']:.1f}s")
            print(f"\n📋 Component Checks:")
            
            for name, check in report["checks"].items():
                icon = "✅" if check["status"] == "healthy" else "⚠️" if check["status"] == "degraded" else "❌"
                print(f"   {icon} {name}: {check['status']} - {check['message']}")
            
            print(f"\n📊 System Metrics:")
            metrics = report["metrics"]
            print(f"   CPU: {metrics['cpu_percent']:.1f}%")
            print(f"   Memory: {metrics['memory_percent']:.1f}%")
            print(f"   Disk: {metrics['disk_percent']:.1f}%")
            print(f"   Threads: {metrics['thread_count']}")
    
    elif args.command == "check":
        if args.component:
            result = checker.run_check(args.component)
            if args.json:
                print(json.dumps(result.to_dict(), indent=2))
            else:
                icon = "✅" if result.status == HealthStatus.HEALTHY else "⚠️" if result.status == HealthStatus.DEGRADED else "❌"
                print(f"{icon} {result.name}: {result.status.value}")
                print(f"   Message: {result.message}")
                print(f"   Response time: {result.response_time_ms:.1f}ms")
        else:
            print("Please specify --component")
    
    elif args.command == "metrics":
        metrics = checker.get_system_metrics()
        perf = _metrics.get_all_stats()
        
        if args.json:
            print(json.dumps({
                "system": metrics.to_dict(),
                "performance": perf
            }, indent=2))
        else:
            print(f"\n📊 System Metrics:")
            print(f"   CPU: {metrics.cpu_percent:.1f}%")
            print(f"   Memory: {metrics.memory_percent:.1f}% ({metrics.memory_used_mb:.0f} MB used)")
            print(f"   Disk: {metrics.disk_percent:.1f}% ({metrics.disk_free_gb:.1f} GB free)")
            print(f"   Python: {metrics.python_version}")
            print(f"   Platform: {metrics.platform}")
            print(f"   Threads: {metrics.thread_count}")
            print(f"   Uptime: {metrics.uptime_seconds:.1f}s")
    
    elif args.command == "server":
        print(f"Starting health server on port {args.port}...")
        server = start_health_server(port=args.port)
        try:
            print(f"Health endpoints available:")
            print(f"  http://127.0.0.1:{args.port}/health")
            print(f"  http://127.0.0.1:{args.port}/health/live")
            print(f"  http://127.0.0.1:{args.port}/health/ready")
            print(f"  http://127.0.0.1:{args.port}/metrics")
            print("\nPress Ctrl+C to stop")
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nStopping server...")
            server.shutdown()


if __name__ == "__main__":
    main()
