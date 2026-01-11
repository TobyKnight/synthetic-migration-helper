import React, { useState, useEffect } from 'react';
import { 
    NerdGraphQuery, AccountStorageQuery, AccountStorageMutation,
    Table, TableHeader, TableHeaderCell, TableRow, TableRowCell, 
    Spinner, Select, SelectItem, Icon, Button, Tooltip, Stack, StackItem
} from 'nr1';

const COLLECTION_ID = "synthetics_migration_v1";
const DOCUMENT_ID = "analysis_results";

// --- Analysis Logic ---
const assessScript = (scriptText) => {
    if (!scriptText) return { status: 'WARN', issues: ['Script content empty or inaccessible'] };
    const text = scriptText; 
    const issues = [];

    // 1. Deprecated HTTP Clients
    if (text.match(/require\s*\(\s*['"]request['"]\s*\)/)) {
        issues.push("CRITICAL: Uses deprecated 'request' module. Replace with 'got' or 'node-fetch'.");
    }
    if (text.match(/require\s*\(\s*['"]unirest['"]\s*\)/)) {
        issues.push("CRITICAL: Uses 'unirest'. Incompatible with newer Node SSL stack.");
    }
    
    // 2. Legacy Selenium Control Flow
    const hasSelenium = text.includes('$browser') || text.includes('$driver');
    const hasAsync = text.includes('async') || text.includes('await');
    if (hasSelenium && !hasAsync) {
        issues.push("CRITICAL: Legacy Control Flow detected (Missing async/await).");
    }

    // 3. Warnings
    if (text.match(/require\s*\(\s*['"]bluebird['"]\s*\)/)) {
        issues.push("WARNING: Uses 'bluebird'. Native Promises are preferred in Node 22.");
    }
    
    if (issues.length === 0) return { status: 'PASS', issues: [] };

    return {
        status: issues.some(i => i.startsWith("CRITICAL")) ? 'FAIL' : 'WARN',
        issues: issues
    };
};

// --- GraphQL Queries ---
const ACCOUNTS_QUERY = `
{
  actor {
    accounts {
      id
      name
    }
  }
}
`;

const MONITOR_QUERY = (accountId, cursor) => `
{
  actor {
    entitySearch(query: "domain = 'SYNTH' AND type = 'MONITOR' AND accountId = ${accountId}") {
      results(cursor: ${cursor ? `"${cursor}"` : null}) {
        nextCursor
        entities {
          guid
          name
          tags { key values }
          account { name id }
          ... on SyntheticMonitorEntityOutline {
            monitorType
          }
        }
      }
    }
  }
}
`;

const SINGLE_SCRIPT_FETCH = (accountId, guid) => `
{
  actor {
    account(id: ${accountId}) {
      synthetics {
        script(monitorGuid: "${guid}") {
          text
        }
      }
    }
  }
}
`;

// --- Main Component ---
export default function MigrationTool() {
    const [accounts, setAccounts] = useState([]);
    const [selectedAccount, setSelectedAccount] = useState(null);
    const [monitors, setMonitors] = useState([]);
    
    const [selectedGuids, setSelectedGuids] = useState([]);
    const [results, setResults] = useState({}); 
    const [analyzing, setAnalyzing] = useState(false);

    const [loadingAccounts, setLoadingAccounts] = useState(true);
    const [loadingMonitors, setLoadingMonitors] = useState(false);

    const getRuntimeInfo = (tags) => {
        if (!tags) return { text: '-', isLegacy: false };
        
        const typeTag = tags.find(t => t.key === 'runtimeType');
        const verTag = tags.find(t => t.key === 'runtimeTypeVersion');
        
        const type = typeTag?.values ? typeTag.values[0] : '';
        const ver = verTag?.values ? verTag.values[0] : '';
        
        if (!type) return { text: '-', isLegacy: false };

        let isLegacy = false;
        if (type.includes('CHROME') && (ver === '100' || ver.startsWith('7'))) isLegacy = true;
        if (type.includes('NODE') && (ver.startsWith('16') || ver.startsWith('10'))) isLegacy = true;

        return { 
            text: `${type} ${ver}`.replace('CHROME_BROWSER', 'Chrome').replace('NODE_API', 'Node'), 
            isLegacy 
        };
    };

    // Load Accounts on Mount
    useEffect(() => {
        async function loadAccounts() {
            setLoadingAccounts(true);
            try {
                const res = await NerdGraphQuery.query({ query: ACCOUNTS_QUERY });
                const list = res?.data?.actor?.accounts || [];
                setAccounts(list);
                if (list.length > 0) setSelectedAccount(String(list[0].id));
            } catch (e) { console.error(e); }
            setLoadingAccounts(false);
        }
        loadAccounts();
    }, []);

    // Load Monitors when Account Changes
    useEffect(() => {
        if (!selectedAccount) return;

        async function fetchData() {
            setLoadingMonitors(true);
            setResults({}); 
            
            try {
                let allEntities = [];
                let cursor = null;
                let hasMore = true;

                const storagePromise = AccountStorageQuery.query({
                    accountId: Number(selectedAccount),
                    collection: COLLECTION_ID,
                    documentId: DOCUMENT_ID
                });

                while (hasMore) {
                    const res = await NerdGraphQuery.query({ query: MONITOR_QUERY(selectedAccount, cursor) });
                    const results = res?.data?.actor?.entitySearch?.results;
                    if (results) {
                        allEntities = [...allEntities, ...results.entities];
                        cursor = results.nextCursor;
                        hasMore = !!cursor;
                    } else { hasMore = false; }
                }

                const targetMonitors = allEntities.filter(e => 
                    e.monitorType === 'SCRIPT_BROWSER' || e.monitorType === 'SCRIPT_API'
                );
                setMonitors(targetMonitors);
                
                const storageRes = await storagePromise;
                if (storageRes?.data) setResults(storageRes.data);

                setSelectedGuids([]); 
            } catch (e) { console.error(e); }
            setLoadingMonitors(false);
        }
        fetchData();
    }, [selectedAccount]);

    // --- NEW: Export CSV Function ---
    const downloadCSV = () => {
        const headers = ["Monitor Name", "Type", "Runtime", "Status", "Issues", "GUID"];

        const rows = monitors.map(mon => {
            const res = results[mon.guid] || { status: 'PENDING', issues: [] };
            const runtime = getRuntimeInfo(mon.tags).text;
            
            // Escape quotes for CSV format to prevent breakage
            const safeName = `"${mon.name.replace(/"/g, '""')}"`;
            const safeIssues = `"${res.issues.join('; ').replace(/"/g, '""')}"`;

            return [
                safeName,
                mon.monitorType === 'SCRIPT_BROWSER' ? 'Browser' : 'API',
                runtime,
                res.status,
                safeIssues,
                mon.guid
            ].join(',');
        });

        const csvContent = [headers.join(','), ...rows].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `migration_analysis_${selectedAccount}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const onSelectRow = (evt, { item }) => {
        const isSelected = selectedGuids.includes(item.guid);
        if (isSelected) setSelectedGuids(prev => prev.filter(g => g !== item.guid));
        else setSelectedGuids(prev => [...prev, item.guid]);
    };

    const handleAnalyze = async () => {
        if (selectedGuids.length === 0) return;
        setAnalyzing(true);

        const targets = monitors.filter(m => selectedGuids.includes(m.guid));
        const updatedResults = { ...results };

        const promises = targets.map(async (mon) => {
            try {
                const res = await NerdGraphQuery.query({ 
                    query: SINGLE_SCRIPT_FETCH(mon.account.id, mon.guid) 
                });
                const scriptText = res?.data?.actor?.account?.synthetics?.script?.text;
                updatedResults[mon.guid] = assessScript(scriptText);
            } catch (err) {
                console.error("Fetch failed for", mon.name);
                updatedResults[mon.guid] = { status: 'ERROR', issues: ['API Error'] };
            }
        });

        await Promise.all(promises);
        setResults(updatedResults);

        try {
            await AccountStorageMutation.mutate({
                accountId: Number(selectedAccount),
                actionType: AccountStorageMutation.ACTION_TYPE.WRITE_DOCUMENT,
                collection: COLLECTION_ID,
                documentId: DOCUMENT_ID,
                document: updatedResults
            });
        } catch (err) { console.error(err); }

        setAnalyzing(false);
    };

    const renderStatus = (guid) => {
        const res = results[guid];
        if (!res) return <span style={{color: '#ccc', fontStyle:'italic'}}>Pending...</span>;

        let color = '#00A52E'; 
        let icon = Icon.TYPE.INTERFACE__SIGN__CHECKMARK;
        
        if (res.status === 'FAIL' || res.status === 'ERROR') { 
            color = '#BF0016'; 
            icon = Icon.TYPE.INTERFACE__SIGN__CLOSE; 
        }
        if (res.status === 'WARN') { 
            color = '#F5A042'; 
            icon = Icon.TYPE.INTERFACE__SIGN__EXCLAMATION; 
        }

        return (
            <div style={{display:'flex', alignItems:'center', color}}>
                <Icon type={icon} color={color} />
                <span style={{fontWeight:'bold', marginLeft:'5px'}}>{res.status}</span>
                {res.issues.length > 0 && (
                     <Tooltip text={res.issues.join("\n")}>
                        <Icon type={Icon.TYPE.INTERFACE__INFO__INFO} style={{marginLeft:'8px', opacity:0.5}} />
                     </Tooltip>
                )}
            </div>
        );
    };

    return (
        <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>
            
            <div style={{ padding: '20px', borderBottom: '1px solid #ddd', backgroundColor:'#f9f9f9', flexShrink: 0 }}>
                <Stack verticalType={Stack.VERTICAL_TYPE.CENTER}>
                    <StackItem grow>
                        <h2 style={{marginBottom:'10px'}}>Migration Assistant</h2>
                        {loadingAccounts ? <Spinner inline /> : (
                            <div style={{width: '350px'}}>
                                {accounts.length > 0 && selectedAccount && (
                                    <Select 
                                        label="Account"
                                        value={selectedAccount} 
                                        onChange={(e, v) => setSelectedAccount(v)}
                                    >
                                        {accounts.map(acc => (
                                            <SelectItem key={acc.id} value={String(acc.id)}>
                                                {`${acc.name} (${acc.id})`}
                                            </SelectItem>
                                        ))}
                                    </Select>
                                )}
                            </div>
                        )}
                    </StackItem>
                    
                    <StackItem>
                        <Button 
                            type={Button.TYPE.PRIMARY} 
                            disabled={selectedGuids.length === 0}
                            loading={analyzing}
                            iconType={Button.ICON_TYPE.HARDWARE_AND_SOFTWARE__SOFTWARE__CODE}
                            onClick={handleAnalyze}
                        >
                            Analyze {selectedGuids.length > 0 ? `(${selectedGuids.length})` : ''}
                        </Button>
                    </StackItem>

                    {/* --- NEW: Export Button --- */}
                    <StackItem>
                        <Button
                            type={Button.TYPE.TERTIARY}
                            iconType={Button.ICON_TYPE.INTERFACE__OPERATIONS__DOWNLOAD}
                            disabled={monitors.length === 0}
                            onClick={downloadCSV}
                        >
                            Export CSV
                        </Button>
                    </StackItem>
                    {/* ------------------------- */}
                </Stack>
            </div>

            <div style={{ flexGrow: 1, overflow: 'auto', padding: '20px' }}>
                {loadingMonitors ? <div style={{textAlign:'center', marginTop:'50px'}}><Spinner/> Loading...</div> : (
                    <Table 
                        items={monitors}
                        selectType="multiple" 
                        selected={({ item }) => selectedGuids.includes(item.guid)}
                        onSelect={onSelectRow}
                    >
                        <TableHeader>
                            <TableHeaderCell width="30%">Monitor Name</TableHeaderCell>
                            <TableHeaderCell width="15%">Type</TableHeaderCell>
                            <TableHeaderCell width="20%">Runtime Ver.</TableHeaderCell>
                            <TableHeaderCell width="15%">Update Status</TableHeaderCell>
                            <TableHeaderCell width="20%">Code Compatibility</TableHeaderCell>
                        </TableHeader>
                        {({ item }) => {
                            const runtime = getRuntimeInfo(item.tags);
                            return (
                                <TableRow>
                                    <TableRowCell>{item.name}</TableRowCell>
                                    <TableRowCell>{item.monitorType === 'SCRIPT_BROWSER' ? 'Browser' : 'API'}</TableRowCell>
                                    <TableRowCell>{runtime.text}</TableRowCell>
                                    <TableRowCell>
                                        {runtime.isLegacy ? (
                                            <span style={{color: '#BF0016', fontWeight: 'bold'}}>
                                                <Icon type={Icon.TYPE.INTERFACE__SIGN__EXCLAMATION__V_ALTERNATE} color="#BF0016"/> Legacy
                                            </span>
                                        ) : (
                                            <span style={{color: '#00A52E', fontWeight: 'bold'}}>
                                                <Icon type={Icon.TYPE.INTERFACE__SIGN__CHECKMARK} color="#00A52E"/> Modern
                                            </span>
                                        )}
                                    </TableRowCell>
                                    <TableRowCell>{renderStatus(item.guid)}</TableRowCell>
                                </TableRow>
                            );
                        }}
                    </Table>
                )}
                
                {!loadingMonitors && monitors.length === 0 && (
                    <div style={{textAlign:'center', padding:'20px', color:'#666'}}>
                        No scripted monitors found in this account.
                    </div>
                )}
            </div>
        </div>
    );
}