"""
AVA Intent Router - Lightweight local intent classification
Routes voice commands to appropriate tool categories
"""

import re
from typing import Optional, Dict, Any, List

# Intent patterns for routing
INTENT_PATTERNS = {
    'computer_control': [
        r'move\s+(?:the\s+)?mouse',
        r'click',
        r'double[-\s]?click',
        r'right[-\s]?click',
        r'scroll',
        r'type\s+',
        r'press\s+',
        r'screenshot',
        r'take\s+(?:a\s+)?screen',
    ],
    'file_operations': [
        r'create\s+(?:a\s+)?(?:new\s+)?file',
        r'make\s+(?:a\s+)?file',
        r'read\s+(?:the\s+)?file',
        r'list\s+(?:the\s+)?files',
        r'delete\s+(?:the\s+)?file',
        r'remove\s+(?:the\s+)?file',
        r'open\s+(?:the\s+)?file',
    ],
    'system': [
        r'system\s+info',
        r'computer\s+info',
        r'device\s+info',
        r'cpu\s+usage',
        r'memory\s+usage',
        r'disk\s+space',
        r'restart',
        r'shutdown',
    ],
    'web': [
        r'search\s+(?:for\s+)?',
        r'open\s+(?:the\s+)?browser',
        r'navigate\s+(?:to\s+)?',
        r'go\s+to\s+(?:https?://|www\.)',
        r'fetch\s+',
        r'get\s+(?:https?://|www\.)',
    ],
    'iot': [
        r'turn\s+(?:on|off)',
        r'lights?\s+(?:on|off)',
        r'set\s+(?:the\s+)?temperature',
        r'thermostat',
    ],
    'calendar': [
        r'schedule\s+(?:a\s+)?',
        r'create\s+(?:an\s+)?event',
        r'add\s+(?:a\s+)?(?:calendar\s+)?event',
        r'meeting\s+(?:at|on)',
        r'remind\s+me',
        r'what.*on\s+(?:my\s+)?calendar',
    ],
    'camera': [
        r'camera',
        r'take\s+(?:a\s+)?(?:picture|photo)',
        r'capture',
        r'what\s+(?:do\s+)?you\s+see',
        r'detect\s+(?:faces?|hands?|motion)',
    ],
    'security': [
        r'scan\s+ports?',
        r'security\s+audit',
        r'check\s+(?:for\s+)?(?:suspicious\s+)?processes?',
        r'network\s+scan',
        r'analyze\s+(?:the\s+)?logs?',
    ],
    'communication': [
        r'send\s+(?:an\s+)?email',
        r'read\s+(?:my\s+)?emails?',
        r'send\s+(?:a\s+)?(?:text|sms)',
        r'email\s+',
    ],
    'vision': [
        r'read\s+(?:the\s+)?screen',
        r'ocr',
        r'analyze\s+(?:the\s+)?image',
        r'describe\s+(?:the\s+)?(?:screen|image)',
    ],
    'window': [
        r'list\s+(?:the\s+)?windows?',
        r'focus\s+(?:the\s+)?',
        r'minimize',
        r'maximize',
        r'close\s+(?:the\s+)?window',
    ],
    'memory': [
        r'remember\s+(?:that\s+)?',
        r'what\s+did\s+I\s+say\s+(?:about|regarding)',
        r'recall',
        r'do\s+you\s+remember',
    ],
    'self_awareness': [
        r'who\s+are\s+you',
        r'what\s+are\s+you',
        r'what\s+can\s+you\s+do',
        r'diagnose\s+yourself',
        r'how\s+are\s+you\s+feeling',
    ],
}

# Tools that require user confirmation
DESTRUCTIVE_PATTERNS = [
    r'\bdelete\b',
    r'\bremove\b',
    r'\bformat\b',
    r'\brestart\b',
    r'\bshutdown\b',
    r'\bsend\s+(?:an?\s+)?(?:email|text|sms)\b',
    r'\bkill\b',
    r'\bterminate\b',
    r'\bturn\s+off\b',
    r'\bstop\s+(?:the\s+)?(?:automation|process)\b',
]


class IntentRouter:
    """Routes voice commands to appropriate handlers"""
    
    def __init__(self):
        self.compiled_patterns = {
            intent: [re.compile(p, re.IGNORECASE) for p in patterns]
            for intent, patterns in INTENT_PATTERNS.items()
        }
        self.destructive_patterns = [re.compile(p, re.IGNORECASE) for p in DESTRUCTIVE_PATTERNS]
    
    def classify_intent(self, transcript: str) -> Optional[str]:
        """Classify transcript into intent category"""
        for intent, patterns in self.compiled_patterns.items():
            for pattern in patterns:
                if pattern.search(transcript):
                    return intent
        return None
    
    def requires_confirmation(self, transcript: str) -> bool:
        """Check if command requires user confirmation"""
        for pattern in self.destructive_patterns:
            if pattern.search(transcript):
                return True
        return False
    
    def extract_entities(self, transcript: str, intent: str) -> Dict[str, Any]:
        """Extract relevant entities based on intent"""
        entities = {}
        low = transcript.lower()
        
        if intent == 'computer_control':
            # Extract coordinates for mouse
            coords = re.search(r'(\d+)[,\s]+(\d+)', transcript)
            if coords:
                entities['x'] = int(coords.group(1))
                entities['y'] = int(coords.group(2))
            # Extract text to type
            type_match = re.search(r'type\s+[\'"]?(.+?)[\'"]?$', transcript, re.IGNORECASE)
            if type_match:
                entities['text'] = type_match.group(1)
                
        elif intent == 'file_operations':
            # Extract filename
            name_match = re.search(r'(?:named?|called)\s+[\'"]?([\w\-. ]+?)[\'"]?', transcript, re.IGNORECASE)
            if name_match:
                entities['filename'] = name_match.group(1)
            # Extract path
            path_match = re.search(r'(?:in|at|from)\s+(?:the\s+)?(?:path\s+)?([\w\\/:~\.\-]+)', transcript, re.IGNORECASE)
            if path_match:
                entities['path'] = path_match.group(1)
                
        elif intent == 'web':
            # Extract URL
            url_match = re.search(r'(https?://\S+|www\.[^\s]+)', transcript)
            if url_match:
                entities['url'] = url_match.group(1)
                if entities['url'].startswith('www.'):
                    entities['url'] = 'https://' + entities['url']
                    
        elif intent == 'calendar':
            # Extract time/date
            time_match = re.search(r'(?:at|for)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)', transcript, re.IGNORECASE)
            if time_match:
                entities['time'] = time_match.group(1)
            # Extract event name
            event_match = re.search(r'(?:event|meeting|called|named)\s+[\'"]?([^\'"]+?)[\'"]?$', transcript, re.IGNORECASE)
            if event_match:
                entities['summary'] = event_match.group(1)
                
        elif intent == 'communication':
            # Extract email
            email_match = re.search(r'([\w\-.+@]+\@[\w\-.]+)', transcript)
            if email_match:
                entities['to'] = email_match.group(1)
            # Extract phone
            phone_match = re.search(r'(\+?\d[\d\s\-]{7,})', transcript)
            if phone_match:
                entities['phone'] = phone_match.group(1).replace(' ', '').replace('-', '')
        
        return entities
    
    def get_suggested_tool(self, intent: str, entities: Dict) -> tuple:
        """Get suggested tool name and arguments for intent"""
        tool_mapping = {
            'computer_control': ('computer_use', {'action': 'click'}),
            'file_operations': ('fs_ops', {'operation': 'list'}),
            'system': ('sys_ops', {'action': 'get_info'}),
            'web': ('browser_automation', {'action': 'launch'}),
            'iot': ('iot_ops', {'action': 'list_devices'}),
            'calendar': ('calendar_ops', {'action': 'list_events'}),
            'camera': ('camera_ops', {'action': 'capture'}),
            'security': ('security_ops', {'action': 'status'}),
            'communication': ('comm_ops', {'action': 'read_emails'}),
            'vision': ('vision_ops', {'action': 'analyze_screen'}),
            'window': ('window_ops', {'action': 'list'}),
            'memory': ('memory_system', {'action': 'retrieve'}),
        }
        return tool_mapping.get(intent, (None, {}))


# Global router instance
_router: Optional[IntentRouter] = None

def get_router() -> IntentRouter:
    """Get or create global intent router"""
    global _router
    if _router is None:
        _router = IntentRouter()
    return _router


def classify_intent(transcript: str) -> Optional[str]:
    """Convenience function to classify intent"""
    return get_router().classify_intent(transcript)


def requires_confirmation(transcript: str) -> bool:
    """Convenience function to check if confirmation needed"""
    return get_router().requires_confirmation(transcript)


def extract_entities(transcript: str, intent: str) -> Dict[str, Any]:
    """Convenience function to extract entities"""
    return get_router().extract_entities(transcript, intent)
