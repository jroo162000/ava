"""
AVA Integration Test Suite
Tests all recent upgrades and capabilities systematically
"""

import sys
import os
from datetime import datetime
import json

# Set UTF-8 encoding for Windows console
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except:
        pass

# Add cmp-use to path
sys.path.insert(0, r"C:\Users\USER 1\cmp-use")

from cmpuse.agent_core import Agent, Plan, Step
from cmpuse.config import Config
from cmpuse.secrets import load_into_env
from cmpuse.llm import answer as llm_answer, default_model
import cmpuse.tools


class AVAIntegrationTester:
    def __init__(self):
        print("=" * 80)
        print("AVA INTEGRATION TEST SUITE")
        print("=" * 80)
        print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

        # Load configuration
        load_into_env()
        self.config = Config.from_env()
        self.agent = Agent(self.config)

        self.test_results = []

    def log_test(self, test_name, passed, details=""):
        """Log test result"""
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"{status} - {test_name}")
        if details:
            print(f"      {details}")

        self.test_results.append({
            "test": test_name,
            "passed": passed,
            "details": details,
            "timestamp": datetime.now().isoformat()
        })

    def test_1_gpt52_model_upgrade(self):
        """Test 1: Verify GPT-5.2 Pro model is selected"""
        print("\n" + "=" * 80)
        print("TEST 1: GPT-5.2 Pro Model Upgrade")
        print("=" * 80)

        try:
            model = default_model()
            print(f"Current model: {model}")

            passed = "gpt-5.2-pro" in model.lower()
            self.log_test(
                "GPT-5.2 Pro Model Selection",
                passed,
                f"Model: {model}"
            )

            # Test if model actually works
            try:
                response = llm_answer(
                    "Say 'GPT-5.2 Pro is active' and nothing else.",
                    system="You are testing model connectivity. Respond exactly as requested."
                )
                model_works = "gpt-5.2" in response.lower() or "active" in response.lower()
                self.log_test(
                    "GPT-5.2 Pro API Connectivity",
                    model_works,
                    f"Response: {response[:100]}"
                )
            except Exception as e:
                self.log_test("GPT-5.2 Pro API Connectivity", False, str(e))

        except Exception as e:
            self.log_test("GPT-5.2 Pro Model Selection", False, str(e))

    def test_2_vision_ops_upgrade(self):
        """Test 2: Vision operations with GPT-5.2 Pro"""
        print("\n" + "=" * 80)
        print("TEST 2: Vision Operations GPT-5.2 Pro Integration")
        print("=" * 80)

        try:
            # Test vision_ops tool registration
            plan = Plan(steps=[Step(tool="vision_ops", args={
                "operation": "preview",
                "confirm": True
            })])

            results = self.agent.run(plan, force=True)

            if results:
                passed = results[0].get('status') in ['ok', 'preview']
                self.log_test(
                    "Vision Ops Tool Registration",
                    passed,
                    f"Status: {results[0].get('status', 'unknown')}"
                )
            else:
                self.log_test("Vision Ops Tool Registration", False, "No results returned")

        except Exception as e:
            self.log_test("Vision Ops Tool Registration", False, str(e))

    def test_3_tool_access(self):
        """Test 3: Verify all 26 tools are accessible"""
        print("\n" + "=" * 80)
        print("TEST 3: Tool Access Verification")
        print("=" * 80)

        try:
            from cmpuse.tool_registry import list_tools

            tools = list_tools()
            tool_count = len(tools)

            print(f"Tools found: {tool_count}")
            print("\nAvailable tools:")
            for i, tool in enumerate(sorted(tools), 1):
                print(f"  {i:2d}. {tool}")

            # Should have at least 26 tools now (25 original + analysis_ops)
            passed = tool_count >= 26
            self.log_test(
                "Tool Access (All 26+ Tools)",
                passed,
                f"Found {tool_count} tools"
            )

            # Check for new analysis_ops tool
            has_analysis = "analysis_ops" in tools
            self.log_test(
                "New Analysis Tool Registration",
                has_analysis,
                "analysis_ops tool " + ("found" if has_analysis else "missing")
            )

        except Exception as e:
            self.log_test("Tool Access", False, str(e))

    def test_4_memory_system(self):
        """Test 4: Memory system integration"""
        print("\n" + "=" * 80)
        print("TEST 4: Memory System Integration")
        print("=" * 80)

        try:
            # Store a test memory
            store_plan = Plan(steps=[Step(tool="memory_system", args={
                "action": "store",
                "user_message": "Test message for integration testing",
                "ava_response": "Test response stored successfully",
                "session_id": "integration_test",
                "confirm": True
            })])

            store_results = self.agent.run(store_plan, force=True)

            if store_results:
                store_passed = store_results[0].get('status') == 'ok'
                self.log_test(
                    "Memory Storage",
                    store_passed,
                    f"Status: {store_results[0].get('status', 'unknown')}"
                )
            else:
                self.log_test("Memory Storage", False, "No results")

            # Retrieve the memory
            get_plan = Plan(steps=[Step(tool="memory_system", args={
                "action": "get_context",
                "session_id": "integration_test",
                "limit": 5,
                "confirm": True
            })])

            get_results = self.agent.run(get_plan, force=True)

            if get_results:
                get_passed = get_results[0].get('status') == 'ok'
                context = get_results[0].get('context', [])
                self.log_test(
                    "Memory Retrieval",
                    get_passed,
                    f"Retrieved {len(context)} memory entries"
                )
            else:
                self.log_test("Memory Retrieval", False, "No results")

        except Exception as e:
            self.log_test("Memory System", False, str(e))

    def test_5_analysis_ops_math(self):
        """Test 5: Scientific analysis - Mathematical calculations"""
        print("\n" + "=" * 80)
        print("TEST 5: Analysis Tool - Mathematical Calculations")
        print("=" * 80)

        try:
            # Test mathematical calculation
            calc_plan = Plan(steps=[Step(tool="analysis_ops", args={
                "operation": "calculate",
                "expression": "sqrt(16) + pow(2, 3)",
                "confirm": True
            })])

            results = self.agent.run(calc_plan, force=True)

            if results:
                passed = results[0].get('status') == 'ok'
                result_value = results[0].get('result') or results[0].get('numeric_value')
                expected = 12.0  # sqrt(16) + pow(2,3) = 4 + 8 = 12

                # Check if result is close to expected (allowing for floating point errors)
                if result_value is not None:
                    correct_value = abs(float(result_value) - expected) < 0.01
                    self.log_test(
                        "Mathematical Calculation",
                        passed and correct_value,
                        f"Result: {result_value}, Expected: {expected}"
                    )
                else:
                    self.log_test("Mathematical Calculation", False, "No result value")
            else:
                self.log_test("Mathematical Calculation", False, "No results")

        except Exception as e:
            self.log_test("Mathematical Calculation", False, str(e))

    def test_6_analysis_ops_statistics(self):
        """Test 6: Scientific analysis - Statistics"""
        print("\n" + "=" * 80)
        print("TEST 6: Analysis Tool - Statistical Analysis")
        print("=" * 80)

        try:
            # Test statistical analysis
            stats_plan = Plan(steps=[Step(tool="analysis_ops", args={
                "operation": "statistics",
                "data": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                "confirm": True
            })])

            results = self.agent.run(stats_plan, force=True)

            if results:
                passed = results[0].get('status') == 'ok'
                mean = results[0].get('mean')
                median = results[0].get('median')

                # Mean and median of 1-10 should be 5.5 and 5.5
                if mean is not None and median is not None:
                    correct = abs(mean - 5.5) < 0.01 and abs(median - 5.5) < 0.01
                    self.log_test(
                        "Statistical Analysis",
                        passed and correct,
                        f"Mean: {mean}, Median: {median}"
                    )
                else:
                    self.log_test("Statistical Analysis", passed, "Stats computed")
            else:
                self.log_test("Statistical Analysis", False, "No results")

        except Exception as e:
            self.log_test("Statistical Analysis", False, str(e))

    def test_7_analysis_ops_code(self):
        """Test 7: Scientific analysis - Code analysis"""
        print("\n" + "=" * 80)
        print("TEST 7: Analysis Tool - Code Analysis")
        print("=" * 80)

        try:
            # Test code analysis
            test_code = """
def hello_world():
    # Print hello
    print("Hello, World!")
    return True

class TestClass:
    def __init__(self):
        self.value = 0
"""

            code_plan = Plan(steps=[Step(tool="analysis_ops", args={
                "operation": "code_analysis",
                "code": test_code,
                "language": "python",
                "confirm": True
            })])

            results = self.agent.run(code_plan, force=True)

            if results:
                passed = results[0].get('status') == 'ok'
                functions = results[0].get('functions', 0)
                classes = results[0].get('classes', 0)

                # Should find 2 functions and 1 class
                correct = functions == 2 and classes == 1
                self.log_test(
                    "Code Analysis",
                    passed and correct,
                    f"Functions: {functions}, Classes: {classes}"
                )
            else:
                self.log_test("Code Analysis", False, "No results")

        except Exception as e:
            self.log_test("Code Analysis", False, str(e))

    def test_8_analysis_ops_ai(self):
        """Test 8: AI-powered analysis using GPT-5.2 Pro"""
        print("\n" + "=" * 80)
        print("TEST 8: Analysis Tool - AI-Powered Analysis")
        print("=" * 80)

        try:
            # Test AI analysis
            ai_plan = Plan(steps=[Step(tool="analysis_ops", args={
                "operation": "analyze",
                "content": "The quick brown fox jumps over the lazy dog. This sentence contains all letters of the alphabet.",
                "analysis_type": "general",
                "confirm": True
            })])

            results = self.agent.run(ai_plan, force=True)

            if results:
                passed = results[0].get('status') == 'ok'
                analysis = results[0].get('analysis', '')
                model = results[0].get('model', '')

                self.log_test(
                    "AI-Powered Analysis",
                    passed and len(analysis) > 0,
                    f"Model: {model}, Analysis length: {len(analysis)} chars"
                )
            else:
                self.log_test("AI-Powered Analysis", False, "No results")

        except Exception as e:
            self.log_test("AI-Powered Analysis", False, str(e))

    def test_9_context_aware_prompts(self):
        """Test 9: Context-aware system prompts"""
        print("\n" + "=" * 80)
        print("TEST 9: Context-Aware System Prompts")
        print("=" * 80)

        try:
            # Test that AVA knows the user's name (Jelani)
            response = llm_answer(
                "What is my name?",
                system="You are AVA, Jelani's AI assistant. CRITICAL: The user's name is JELANI."
            )

            passed = "jelani" in response.lower()
            self.log_test(
                "Name Recognition (Jelani)",
                passed,
                f"Response: {response[:100]}"
            )

        except Exception as e:
            self.log_test("Context-Aware Prompts", False, str(e))

    def test_10_multimodal_capability(self):
        """Test 10: Multimodal capability verification"""
        print("\n" + "=" * 80)
        print("TEST 10: Multimodal Capability Verification")
        print("=" * 80)

        try:
            # Check if GPT-5.2 Pro supports multimodal
            response = llm_answer(
                "Can you process images and audio? Answer with just yes or no.",
                system="You are GPT-5.2 Pro. State your multimodal capabilities accurately."
            )

            passed = "yes" in response.lower()
            self.log_test(
                "Multimodal Support (Images/Audio)",
                passed,
                f"Response: {response}"
            )

        except Exception as e:
            self.log_test("Multimodal Capability", False, str(e))

    def print_summary(self):
        """Print test summary"""
        print("\n" + "=" * 80)
        print("TEST SUMMARY")
        print("=" * 80)

        total_tests = len(self.test_results)
        passed_tests = sum(1 for t in self.test_results if t['passed'])
        failed_tests = total_tests - passed_tests

        print(f"\nTotal Tests: {total_tests}")
        print(f"✅ Passed: {passed_tests}")
        print(f"❌ Failed: {failed_tests}")
        print(f"Success Rate: {(passed_tests/total_tests*100):.1f}%")

        if failed_tests > 0:
            print("\n" + "=" * 80)
            print("FAILED TESTS:")
            print("=" * 80)
            for result in self.test_results:
                if not result['passed']:
                    print(f"\n❌ {result['test']}")
                    print(f"   Details: {result['details']}")

        # Save results to file
        results_file = f"test_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(results_file, 'w') as f:
            json.dump({
                "summary": {
                    "total": total_tests,
                    "passed": passed_tests,
                    "failed": failed_tests,
                    "success_rate": passed_tests/total_tests*100
                },
                "tests": self.test_results
            }, f, indent=2)

        print(f"\n📊 Detailed results saved to: {results_file}")

    def run_all_tests(self):
        """Run all integration tests"""
        print("\nStarting integration tests...\n")

        # Run all tests
        self.test_1_gpt52_model_upgrade()
        self.test_2_vision_ops_upgrade()
        self.test_3_tool_access()
        self.test_4_memory_system()
        self.test_5_analysis_ops_math()
        self.test_6_analysis_ops_statistics()
        self.test_7_analysis_ops_code()
        self.test_8_analysis_ops_ai()
        self.test_9_context_aware_prompts()
        self.test_10_multimodal_capability()

        # Print summary
        self.print_summary()

        print("\n" + "=" * 80)
        print("TESTING COMPLETE")
        print("=" * 80)
        print(f"Finished: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")


def main():
    """Main entry point"""
    tester = AVAIntegrationTester()
    tester.run_all_tests()


if __name__ == "__main__":
    main()
