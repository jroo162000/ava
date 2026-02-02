"""
Unit Tests for AVA Health Check Module
======================================
Tests the health monitoring and metrics functionality.
"""

import os
import sys
import json
import time
import pytest
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from ava_health import (
    HealthChecker,
    HealthStatus,
    ComponentHealth,
    SystemMetrics,
    MetricsCollector,
    get_health_status,
    get_health_checker,
    check_component,
    is_healthy,
    record_timing,
    increment_counter,
    timed
)


class TestHealthStatus:
    """Tests for HealthStatus enum"""
    
    def test_health_status_values(self):
        """Test HealthStatus has expected values"""
        assert HealthStatus.HEALTHY.value == "healthy"
        assert HealthStatus.DEGRADED.value == "degraded"
        assert HealthStatus.UNHEALTHY.value == "unhealthy"
        assert HealthStatus.UNKNOWN.value == "unknown"


class TestComponentHealth:
    """Tests for ComponentHealth dataclass"""
    
    def test_component_health_creates(self):
        """Test ComponentHealth creation"""
        health = ComponentHealth(
            name="test",
            status=HealthStatus.HEALTHY,
            message="All good"
        )
        assert health.name == "test"
        assert health.status == HealthStatus.HEALTHY
        assert health.message == "All good"
    
    def test_component_health_to_dict(self):
        """Test ComponentHealth serialization"""
        health = ComponentHealth(
            name="test",
            status=HealthStatus.HEALTHY,
            message="All good",
            response_time_ms=10.5,
            details={"key": "value"}
        )
        
        d = health.to_dict()
        
        assert d["name"] == "test"
        assert d["status"] == "healthy"
        assert d["message"] == "All good"
        assert d["response_time_ms"] == 10.5
        assert d["details"]["key"] == "value"
        assert "last_check" in d


class TestSystemMetrics:
    """Tests for SystemMetrics dataclass"""
    
    def test_system_metrics_creates(self):
        """Test SystemMetrics creation"""
        metrics = SystemMetrics(
            cpu_percent=50.0,
            memory_percent=60.0,
            memory_used_mb=1024.0,
            memory_available_mb=2048.0,
            disk_percent=40.0,
            disk_used_gb=100.0,
            disk_free_gb=150.0,
            python_version="3.11.0",
            platform="win32",
            uptime_seconds=3600.0,
            thread_count=4
        )
        
        assert metrics.cpu_percent == 50.0
        assert metrics.memory_percent == 60.0
        assert metrics.thread_count == 4
    
    def test_system_metrics_to_dict(self):
        """Test SystemMetrics serialization"""
        metrics = SystemMetrics(
            cpu_percent=50.0,
            memory_percent=60.0,
            memory_used_mb=1024.0,
            memory_available_mb=2048.0,
            disk_percent=40.0,
            disk_used_gb=100.0,
            disk_free_gb=150.0,
            python_version="3.11.0",
            platform="win32",
            uptime_seconds=3600.0,
            thread_count=4
        )
        
        d = metrics.to_dict()
        
        assert d["cpu_percent"] == 50.0
        assert d["platform"] == "win32"


class TestMetricsCollector:
    """Tests for MetricsCollector class"""
    
    def test_metrics_collector_creates(self):
        """Test MetricsCollector initialization"""
        collector = MetricsCollector()
        assert collector is not None
    
    def test_record_timing(self):
        """Test recording timing metrics"""
        collector = MetricsCollector()
        
        collector.record_timing("test_op", 100.0)
        collector.record_timing("test_op", 150.0)
        
        stats = collector.get_timing_stats("test_op")
        
        assert stats["count"] == 2
        assert stats["min_ms"] == 100.0
        assert stats["max_ms"] == 150.0
        assert stats["avg_ms"] == 125.0
    
    def test_increment_counter(self):
        """Test counter increment"""
        collector = MetricsCollector()
        
        collector.increment_counter("requests")
        collector.increment_counter("requests")
        collector.increment_counter("requests", 5)
        
        stats = collector.get_all_stats()
        
        assert stats["counters"]["requests"] == 7
    
    def test_set_gauge(self):
        """Test gauge setting"""
        collector = MetricsCollector()
        
        collector.set_gauge("temperature", 72.5)
        
        stats = collector.get_all_stats()
        
        assert stats["gauges"]["temperature"] == 72.5
    
    def test_timing_stats_empty(self):
        """Test timing stats for non-existent metric"""
        collector = MetricsCollector()
        
        stats = collector.get_timing_stats("nonexistent")
        
        assert stats["count"] == 0


class TestHealthChecker:
    """Tests for HealthChecker class"""
    
    def test_health_checker_creates(self, temp_dir):
        """Test HealthChecker initialization"""
        checker = HealthChecker(integration_dir=temp_dir)
        assert checker is not None
    
    def test_health_checker_has_default_checks(self, temp_dir):
        """Test default checks are registered"""
        checker = HealthChecker(integration_dir=temp_dir)
        
        expected_checks = ["system", "database", "api_keys", "voice_engine", "python_worker", "config_files"]
        
        for check in expected_checks:
            assert check in checker._checks
    
    def test_run_check_system(self, temp_dir):
        """Test running system check"""
        checker = HealthChecker(integration_dir=temp_dir)
        
        result = checker.run_check("system")
        
        assert isinstance(result, ComponentHealth)
        assert result.name == "system"
        assert result.status in [HealthStatus.HEALTHY, HealthStatus.DEGRADED, HealthStatus.UNHEALTHY]
        assert result.response_time_ms > 0
    
    def test_run_check_unknown(self, temp_dir):
        """Test running unknown check"""
        checker = HealthChecker(integration_dir=temp_dir)
        
        result = checker.run_check("nonexistent_check")
        
        assert result.status == HealthStatus.UNKNOWN
        assert "Unknown check" in result.message
    
    def test_run_all_checks(self, temp_dir):
        """Test running all checks"""
        checker = HealthChecker(integration_dir=temp_dir)
        
        results = checker.run_all_checks()
        
        assert len(results) >= 5
        for name, result in results.items():
            assert isinstance(result, ComponentHealth)
    
    def test_get_overall_status(self, temp_dir):
        """Test getting overall status"""
        checker = HealthChecker(integration_dir=temp_dir)
        
        status = checker.get_overall_status()
        
        assert status in [HealthStatus.HEALTHY, HealthStatus.DEGRADED, HealthStatus.UNHEALTHY]
    
    def test_get_system_metrics(self, temp_dir):
        """Test getting system metrics"""
        checker = HealthChecker(integration_dir=temp_dir)
        
        metrics = checker.get_system_metrics()
        
        assert isinstance(metrics, SystemMetrics)
        assert metrics.cpu_percent >= 0
        assert metrics.memory_percent >= 0
        assert metrics.thread_count >= 1
    
    def test_get_full_report(self, temp_dir):
        """Test getting full report"""
        checker = HealthChecker(integration_dir=temp_dir)
        
        report = checker.get_full_report()
        
        assert "status" in report
        assert "timestamp" in report
        assert "uptime_seconds" in report
        assert "checks" in report
        assert "metrics" in report
        assert "performance" in report
    
    def test_register_custom_check(self, temp_dir):
        """Test registering custom check"""
        checker = HealthChecker(integration_dir=temp_dir)
        
        def custom_check():
            return ComponentHealth(
                name="custom",
                status=HealthStatus.HEALTHY,
                message="Custom check passed"
            )
        
        checker.register_check("custom", custom_check)
        
        result = checker.run_check("custom")
        
        assert result.name == "custom"
        assert result.status == HealthStatus.HEALTHY


class TestConvenienceFunctions:
    """Tests for module-level convenience functions"""
    
    def test_get_health_checker_returns_instance(self):
        """Test get_health_checker returns HealthChecker"""
        checker = get_health_checker()
        assert isinstance(checker, HealthChecker)
    
    def test_get_health_checker_returns_same_instance(self):
        """Test get_health_checker returns singleton"""
        checker1 = get_health_checker()
        checker2 = get_health_checker()
        assert checker1 is checker2
    
    def test_get_health_status_returns_dict(self):
        """Test get_health_status returns report dict"""
        status = get_health_status()
        
        assert isinstance(status, dict)
        assert "status" in status
        assert "checks" in status
    
    def test_check_component(self):
        """Test check_component function"""
        result = check_component("system")
        
        assert isinstance(result, ComponentHealth)
        assert result.name == "system"
    
    def test_is_healthy_returns_bool(self):
        """Test is_healthy returns boolean"""
        result = is_healthy()
        
        assert isinstance(result, bool)


class TestGlobalMetricsFunctions:
    """Tests for global metrics functions"""
    
    def test_record_timing_global(self):
        """Test global record_timing function"""
        record_timing("test_global", 50.0)
        # Should not raise
    
    def test_increment_counter_global(self):
        """Test global increment_counter function"""
        increment_counter("test_counter")
        increment_counter("test_counter", 5)
        # Should not raise


class TestTimedDecorator:
    """Tests for @timed decorator"""
    
    def test_timed_decorator_works(self):
        """Test @timed decorator times function"""
        @timed("decorated_function")
        def slow_function():
            time.sleep(0.01)
            return "result"
        
        result = slow_function()
        
        assert result == "result"
    
    def test_timed_decorator_handles_exceptions(self):
        """Test @timed decorator handles exceptions"""
        @timed("failing_function")
        def failing_function():
            raise ValueError("Test error")
        
        with pytest.raises(ValueError):
            failing_function()


class TestDatabaseCheck:
    """Tests for database health check"""
    
    def test_database_check_missing_files(self, temp_dir):
        """Test database check with missing files"""
        checker = HealthChecker(integration_dir=temp_dir)
        
        result = checker.run_check("database")
        
        # Should be degraded because DB files don't exist
        assert result.status in [HealthStatus.DEGRADED, HealthStatus.UNHEALTHY]
    
    def test_database_check_with_valid_db(self, temp_dir):
        """Test database check with valid database"""
        import sqlite3
        
        # Create a test database
        db_path = temp_dir / "ava_self_awareness.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE test (id INTEGER)")
        conn.close()
        
        checker = HealthChecker(integration_dir=temp_dir)
        result = checker.run_check("database")
        
        # Should have at least one OK database
        assert "self_awareness" in result.details
        assert result.details["self_awareness"]["status"] == "ok"


class TestConfigFilesCheck:
    """Tests for config files health check"""
    
    def test_config_check_missing_files(self, temp_dir):
        """Test config check with missing files"""
        checker = HealthChecker(integration_dir=temp_dir)
        
        result = checker.run_check("config_files")
        
        assert result.status == HealthStatus.DEGRADED
        assert "missing" in result.details["voice_config"]
    
    def test_config_check_with_valid_config(self, temp_dir):
        """Test config check with valid config files"""
        # Create valid config files
        voice_config = temp_dir / "ava_voice_config.json"
        voice_config.write_text('{"test": true}')
        
        identity = temp_dir / "ava_identity.json"
        identity.write_text('{"name": "AVA"}')
        
        checker = HealthChecker(integration_dir=temp_dir)
        result = checker.run_check("config_files")
        
        assert result.status == HealthStatus.HEALTHY
        assert result.details["voice_config"] == "valid"
        assert result.details["identity"] == "valid"
    
    def test_config_check_with_invalid_json(self, temp_dir):
        """Test config check with invalid JSON"""
        # Create invalid config file
        voice_config = temp_dir / "ava_voice_config.json"
        voice_config.write_text('invalid json {')
        
        checker = HealthChecker(integration_dir=temp_dir)
        result = checker.run_check("config_files")
        
        assert result.status == HealthStatus.UNHEALTHY
        assert "invalid" in result.details["voice_config"]
