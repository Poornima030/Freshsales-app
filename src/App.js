import React, { useState, useEffect, useRef } from 'react';
import { db } from './firebase';
import { ref, push, set, remove, onValue } from 'firebase/database';
import './App.css';

// ── Validation ──────────────────────────────────────────
function validateContact(c) {
  const errors = [];
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email.trim())) {
    errors.push(`Email "${c.email}" looks invalid`);
  }
  if (c.phone) {
    const digits = c.phone.replace(/[\s\-\(\)\+\.]/g, '');
    if (!/^\d{7,15}$/.test(digits)) {
      errors.push(`Phone "${c.phone}" has unusual digit count (expected 7–15)`);
    }
  }
  return errors;
}

// ── Contact Card ────────────────────────────────────────
function ContactCard({ contact, onEdit, onDelete }) {
  const initials = (contact.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const role = [contact.title, contact.company].filter(Boolean).join(' · ') || '—';
  const dateStr = contact.created
    ? new Date(contact.created).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

  return (
    <div className="contact-card">
      <span className={`contact-source ${contact.source === 'image' ? 'source-image' : 'source-text'}`}>
        {contact.source === 'image' ? '📷 Card' : '✏️ Text'}
      </span>
      {contact.flagged && (
        <div className="flagged-badge">⚠ Flagged — check email/phone</div>
      )}
      <div className="contact-avatar">{initials}</div>
      <div className="contact-name">{contact.name || '—'}</div>
      <div className="contact-role">{role}</div>
      <div className="contact-fields">
        {contact.email   && <div className="contact-field"><span>✉</span><span>{contact.email}</span></div>}
        {contact.phone   && <div className="contact-field"><span>📞</span><span>{contact.phone}</span></div>}
        {contact.website && <div className="contact-field"><span>🌐</span><span>{contact.website}</span></div>}
        {contact.address && <div className="contact-field"><span>📍</span><span>{contact.address}</span></div>}
        {contact.notes   && <div className="contact-field"><span>📝</span><span>{contact.notes}</span></div>}
      </div>
      {dateStr && <div className="contact-meta">Added {dateStr}</div>}
      <div className="contact-actions">
        <button className="btn-sm" onClick={() => onEdit(contact)}>Edit</button>
        <button className="btn-danger-sm" onClick={() => onDelete(contact._key)}>Delete</button>
      </div>
    </div>
  );
}

// ── Edit Modal ──────────────────────────────────────────
function EditModal({ contact, onSave, onClose }) {
  const fields = ['name','title','company','email','phone','website','address','notes'];
  const [form, setForm] = useState({});

  useEffect(() => {
    const init = {};
    fields.forEach(f => { init[f] = contact[f] || ''; });
    setForm(init);
  }, [contact]);

  const handleSave = () => {
    const updated = {};
    fields.forEach(f => { updated[f] = form[f].trim() || null; });
    const errs = validateContact(updated);
    if (errs.length) {
      if (!window.confirm('⚠️ Validation warning:\n\n' + errs.join('\n') + '\n\nSave anyway?')) return;
      updated.flagged = true;
    } else {
      updated.flagged = false;
    }
    onSave(contact._key, { ...updated, source: contact.source, created: contact.created });
  };

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div className="modal-title">
          Edit Contact
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        {fields.map(f => (
          <div className="field-group" key={f}>
            <label className="field-label">{f.charAt(0).toUpperCase() + f.slice(1)}</label>
            <input
              className="field-input"
              value={form[f] || ''}
              onChange={e => setForm({ ...form, [f]: e.target.value })}
              type={f === 'email' ? 'email' : 'text'}
            />
          </div>
        ))}
        <div className="modal-actions">
          <button className="btn btn-cancel" onClick={onClose}>Cancel</button>
          <button className="btn btn-save" onClick={handleSave}>Save Changes</button>
        </div>
      </div>
    </div>
  );
}

// ── Main App ────────────────────────────────────────────
export default function App() {
  const [contacts, setContacts]     = useState([]);
  const [tab, setTab]               = useState('image');
  const [file, setFile]             = useState(null);
  const [preview, setPreview]       = useState(null);
  const [text, setText]             = useState('');
  const [loading, setLoading]       = useState(false);
  const [toast, setToast]           = useState(null);
  const [search, setSearch]         = useState('');
  const [syncStatus, setSyncStatus] = useState('connecting');
  const [editContact, setEditContact] = useState(null);
  const [dragging, setDragging]     = useState(false);
  const fileRef = useRef();
  const contactsRef = ref(db, 'contacts');

  // ── Firebase listener ──────────────────────────────
  useEffect(() => {
    const unsub = onValue(contactsRef, snap => {
      const list = [];
      snap.forEach(child => list.push({ ...child.val(), _key: child.key }));
      setContacts(list.reverse());
      setSyncStatus('live');
    }, () => setSyncStatus('offline'));
    return () => unsub();
  }, []);

  // ── Toast ──────────────────────────────────────────
  const showToast = (msg, type) => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  // ── File handling ──────────────────────────────────
  const loadFile = f => {
    if (!f || !f.type.startsWith('image/')) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const onDrop = e => {
    e.preventDefault();
    setDragging(false);
    loadFile(e.dataTransfer.files[0]);
  };

  // ── Extract ────────────────────────────────────────
  const extract = async () => {
    if (tab === 'image' && !file) { showToast('Please upload an image', 'error'); return; }
    if (tab === 'text' && !text.trim()) { showToast('Please paste some text', 'error'); return; }

    setLoading(true);
    try {
      let body;
      const prompt = 'Look at this and extract contact information. Return ONLY a valid JSON object with exactly these fields (null if not found), no markdown, no explanation: {"name":null,"title":null,"company":null,"email":null,"phone":null,"website":null,"address":null,"notes":null}';

      if (tab === 'image') {
        const b64 = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = e => res(e.target.result.split(',')[1]);
          reader.onerror = rej;
          reader.readAsDataURL(file);
        });
        body = {
          contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: file.type, data: b64 } }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
        };
      } else {
        body = {
          contents: [{ parts: [{ text: prompt + '\n\nContact info:\n' + text }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
        };
      }

      const res = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      if (!data.candidates?.[0]) throw new Error('No response from Gemini');

      const raw = data.candidates[0].content.parts[0].text || '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Could not find JSON in response');
      const contact = JSON.parse(match[0]);

      contact.source  = tab;
      contact.created = new Date().toISOString();
      contact.flagged = false;

      const errs = validateContact(contact);
      if (errs.length) {
        if (!window.confirm('⚠️ Validation warning:\n\n' + errs.join('\n') + '\n\nSave anyway?')) {
          setLoading(false); return;
        }
        contact.flagged = true;
      }

      const newRef = push(contactsRef);
      await set(newRef, contact);

      showToast('Contact saved!', 'success');
      setFile(null); setPreview(null); setText('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      showToast(err.message || 'Something went wrong', 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── Edit / Delete ──────────────────────────────────
  const handleSaveEdit = async (key, updated) => {
    try {
      await set(ref(db, 'contacts/' + key), updated);
      showToast('Contact updated', 'success');
      setEditContact(null);
    } catch { showToast('Update failed', 'error'); }
  };

  const handleDelete = async key => {
    if (!window.confirm('Delete this contact?')) return;
    try {
      await remove(ref(db, 'contacts/' + key));
      showToast('Deleted', 'success');
    } catch { showToast('Delete failed', 'error'); }
  };

  const handleClearAll = async () => {
    if (!contacts.length) return;
    if (!window.confirm('Delete ALL contacts? This cannot be undone.')) return;
    try {
      await remove(contactsRef);
      showToast('All contacts cleared', 'success');
    } catch { showToast('Clear failed', 'error'); }
  };

  // ── Export CSV ─────────────────────────────────────
  const exportCSV = () => {
    if (!contacts.length) { showToast('No contacts to export', 'error'); return; }
    const fields = ['name','title','company','email','phone','website','address','notes','source','created'];
    const rows = [fields.join(','), ...contacts.map(c =>
      fields.map(f => '"' + String(c[f] || '').replace(/"/g, '""') + '"').join(',')
    )].join('\r\n');
    const blob = new Blob([rows], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `freshsales_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('CSV downloaded!', 'success');
  };

  // ── Filter ─────────────────────────────────────────
  const filtered = contacts.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [c.name, c.email, c.company, c.phone].some(v => v && v.toLowerCase().includes(q));
  });

  const today = new Date().toDateString();
  const todayCount = contacts.filter(c => new Date(c.created).toDateString() === today).length;

  // ── Render ─────────────────────────────────────────
  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="logo">Fresh<span>sales</span></div>
        <div className="stat-bar">
          <div><strong>{contacts.length}</strong><span>total</span></div>
          <div><strong>{todayCount}</strong><span>today</span></div>
        </div>
        <div className="header-right">
          <div className="sync-indicator">
            <div className={`sync-dot ${syncStatus === 'offline' ? 'offline' : ''}`}/>
            <span>{syncStatus}</span>
          </div>
          <div className="badge">SHARED DB</div>
        </div>
      </header>

      <div className="main">
        {/* Sidebar */}
        <aside className="sidebar">
          <div>
            <div className="section-title">Input Method</div>
            <div className="tab-row">
              <button className={`tab-btn ${tab === 'image' ? 'active' : ''}`} onClick={() => setTab('image')}>📷 Image</button>
              <button className={`tab-btn ${tab === 'text'  ? 'active' : ''}`} onClick={() => setTab('text')}>✏️ Text</button>
            </div>
          </div>

          {tab === 'image' ? (
            <div className="panel">
              <div
                className={`drop-zone ${dragging ? 'dragover' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => fileRef.current?.click()}
              >
                <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }} onChange={e => loadFile(e.target.files[0])} />
                <div className="drop-icon">🪪</div>
                <p><strong>Drop business card here</strong>or click to upload<br/><small>JPG, PNG, WEBP</small></p>
              </div>
              {preview && <img src={preview} alt="Preview" className="preview-img"/>}
            </div>
          ) : (
            <div className="panel">
              <textarea
                className="text-area"
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder={"Paste WhatsApp message here...\n\ne.g.\nJohn Smith\nCEO, Acme Corp\njohn@acme.com\n+91 98765 43210"}
              />
            </div>
          )}

          {toast && <div className={`toast ${toast.type}`}>{toast.type === 'success' ? '✓ ' : '⚠ '}{toast.msg}</div>}

          <button className="btn btn-primary" onClick={extract} disabled={loading}>
            {loading ? <span className="spinner"/> : '✦ Extract & Save Contact'}
          </button>
        </aside>

        {/* Contacts Panel */}
        <div className="right-panel">
          <div className="list-header">
            <div className="list-title">Contacts <span className="count-label">({filtered.length})</span></div>
            <div className="list-controls">
              <input className="search-input" type="text" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} />
              <button className="btn-sm" onClick={exportCSV}>⬇ CSV</button>
              <button className="btn-sm danger" onClick={handleClearAll}>🗑 Clear all</button>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🪪</div>
              <p>{syncStatus === 'connecting' ? 'Connecting to database...' : 'No contacts yet.\nUpload a business card or paste contact info.'}</p>
            </div>
          ) : (
            <div className="contacts-grid">
              {filtered.map(c => (
                <ContactCard key={c._key} contact={c} onEdit={setEditContact} onDelete={handleDelete} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Edit Modal */}
      {editContact && (
        <EditModal contact={editContact} onSave={handleSaveEdit} onClose={() => setEditContact(null)} />
      )}
    </div>
  );
}
