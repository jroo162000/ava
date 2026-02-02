import sqlite3
import os

# Clean up old 'John' entries from ava_memory.db
mem_db = os.path.expanduser('~/.cmpuse/ava_memory.db')
try:
    conn = sqlite3.connect(mem_db)
    c = conn.cursor()
    c.execute("DELETE FROM user_facts WHERE fact_type = 'name' AND fact_value = 'John'")
    print(f'Deleted John from ava_memory.db: {c.rowcount} rows')
    conn.commit()
    conn.close()
except Exception as e:
    print(f'Error: {e}')

# Verify remaining facts
conn = sqlite3.connect(mem_db)
c = conn.cursor()
c.execute('SELECT fact_type, fact_value FROM user_facts')
print('Remaining facts in ava_memory.db:')
for row in c.fetchall():
    print(f'  {row[0]}: {row[1]}')
conn.close()
