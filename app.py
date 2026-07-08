"""
AI Chatbot Pro - Full-stack with SQLite, Auth, Glassmorphism UI
"""
import os
import json
import time
import random
import re
import threading
from datetime import datetime
from io import BytesIO

from flask import (
    Flask, render_template, request, jsonify, Response,
    stream_with_context, redirect, url_for, send_file
)
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager, UserMixin, login_user, logout_user,
    login_required, current_user
)
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from dotenv import load_dotenv
from google import genai
from google.genai import types
from PIL import Image

load_dotenv()

# ─── App setup ───────────────────────────────────────────────
app = Flask(__name__)
app.config["SECRET_KEY"] = os.urandom(24).hex()
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///chatbot.db"
app.config["UPLOAD_FOLDER"] = os.path.join(os.path.dirname(__file__), "uploads")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16MB max
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = "login_page"

# ─── Google AI Client ────────────────────────────────────────
API_KEY = os.getenv("GOOGLE_API_KEY")
if not API_KEY:
    raise ValueError("GOOGLE_API_KEY not set in .env file")
client = genai.Client(api_key=API_KEY)

AVAILABLE_MODELS = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"]
DEFAULT_MODEL = "gemini-2.0-flash"

# ─── Database Models ─────────────────────────────────────────
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    avatar = db.Column(db.String(256), default="")
    theme = db.Column(db.String(10), default="dark")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    conversations = db.relationship("Conversation", backref="user", lazy="dynamic", cascade="all, delete-orphan")

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)
    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

class Conversation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    uuid = db.Column(db.String(64), unique=True, nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    title = db.Column(db.String(200), default="New Chat")
    model = db.Column(db.String(50), default=DEFAULT_MODEL)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    messages = db.relationship("Message", backref="conversation", lazy="dynamic", cascade="all, delete-orphan", order_by="Message.timestamp")

class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    conversation_id = db.Column(db.Integer, db.ForeignKey("conversation.id"), nullable=False)
    role = db.Column(db.String(10), nullable=False)  # user / model
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)

with app.app_context():
    db.create_all()

# ─── Login manager ───────────────────────────────────────────
@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))

# ─── AI Helpers ──────────────────────────────────────────────
SYSTEM_PROMPT = """You are a helpful, friendly, and knowledgeable AI assistant. 
Format responses using Markdown. Be concise but thorough."""

def format_history_for_gemini(history_messages):
    gemini_contents = []
    for msg in history_messages:
        role = "user" if msg.role == "user" else "model"
        gemini_contents.append(types.Content(
            role=role, parts=[types.Part.from_text(text=msg.content)]
        ))
    return gemini_contents

def get_chat_config():
    return types.GenerateContentConfig(
        temperature=0.7, top_p=0.95, top_k=40,
        max_output_tokens=8192, system_instruction=SYSTEM_PROMPT,
    )

def create_chat_session(model_name, history=None):
    if history:
        return client.chats.create(model=model_name, history=history, config=get_chat_config())
    return client.chats.create(model=model_name, config=get_chat_config())

def is_quota_error(msg):
    return "429" in msg and "RESOURCE_EXHAUSTED" in msg

def extract_retry_seconds(msg):
    m = re.search(r'retry in ([\d.]+)s', msg)
    return float(m.group(1)) if m else None

# ─── Auth Routes ─────────────────────────────────────────────
@app.route("/login", methods=["GET", "POST"])
def login_page():
    if current_user.is_authenticated:
        return redirect(url_for("chat_page"))
    if request.method == "POST":
        data = request.get_json() or request.form
        username = data.get("username", "")
        password = data.get("password", "")
        user = User.query.filter_by(username=username).first()
        if user and user.check_password(password):
            login_user(user)
            next_page = request.args.get("next") or url_for("chat_page")
            if request.is_json:
                return jsonify({"ok": True, "redirect": next_page})
            return redirect(next_page)
        if request.is_json:
            return jsonify({"ok": False, "error": "Invalid credentials"}), 401
        return render_template("login.html", error="Invalid credentials")
    return render_template("login.html")

@app.route("/register", methods=["GET", "POST"])
def register_page():
    if current_user.is_authenticated:
        return redirect(url_for("chat_page"))
    if request.method == "POST":
        data = request.get_json() or request.form
        username = data.get("username", "").strip()
        email = data.get("email", "").strip()
        password = data.get("password", "")
        if not username or not email or not password:
            err = "All fields are required"
            if request.is_json:
                return jsonify({"ok": False, "error": err}), 400
            return render_template("register.html", error=err)
        if User.query.filter_by(username=username).first():
            err = "Username already taken"
            if request.is_json:
                return jsonify({"ok": False, "error": err}), 400
            return render_template("register.html", error=err)
        if User.query.filter_by(email=email).first():
            err = "Email already registered"
            if request.is_json:
                return jsonify({"ok": False, "error": err}), 400
            return render_template("register.html", error=err)
        user = User(username=username, email=email)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()
        login_user(user)
        if request.is_json:
            return jsonify({"ok": True, "redirect": url_for("chat_page")})
        return redirect(url_for("chat_page"))
    return render_template("register.html")

@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("login_page"))

# ─── Chat Page ───────────────────────────────────────────────
@app.route("/")
@login_required
def chat_page():
    return render_template("index.html")

# ─── Profile / Settings ──────────────────────────────────────
@app.route("/api/profile", methods=["GET", "PUT"])
@login_required
def api_profile():
    if request.method == "GET":
        return jsonify({
            "username": current_user.username,
            "email": current_user.email,
            "avatar": current_user.avatar or "",
            "theme": current_user.theme,
            "created_at": current_user.created_at.isoformat() if current_user.created_at else "",
        })
    data = request.get_json()
    if "theme" in data and data["theme"] in ("dark", "light"):
        current_user.theme = data["theme"]
    if "username" in data:
        new_name = data["username"].strip()
        if new_name and new_name != current_user.username:
            if User.query.filter_by(username=new_name).first():
                return jsonify({"error": "Username taken"}), 400
            current_user.username = new_name
    if "password" in data and data["password"]:
        current_user.set_password(data["password"])
    db.session.commit()
    return jsonify({"ok": True, "theme": current_user.theme, "username": current_user.username})

@app.route("/api/profile/avatar", methods=["POST"])
@login_required
def api_upload_avatar():
    if "avatar" not in request.files:
        return jsonify({"error": "No file"}), 400
    file = request.files["avatar"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else "png"
    filename = f"user_{current_user.id}_avatar.{ext}"
    path = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    img = Image.open(file)
    img.thumbnail((200, 200))
    img.save(path)
    # Clean old avatar
    if current_user.avatar and current_user.avatar != filename:
        old = os.path.join(app.config["UPLOAD_FOLDER"], current_user.avatar)
        if os.path.exists(old):
            os.remove(old)
    current_user.avatar = filename
    db.session.commit()
    return jsonify({"ok": True, "avatar": filename})

@app.route("/uploads/<filename>")
def uploaded_file(filename):
    return send_file(os.path.join(app.config["UPLOAD_FOLDER"], filename))

# ─── Conversations API ───────────────────────────────────────
@app.route("/api/conversations", methods=["GET"])
@login_required
def list_conversations():
    convs = Conversation.query.filter_by(user_id=current_user.id)\
        .order_by(Conversation.updated_at.desc()).all()
    return jsonify({
        "conversations": [{
            "id": c.uuid,
            "title": c.title,
            "message_count": c.messages.count(),
            "created_at": c.created_at.isoformat() if c.created_at else "",
            "model": c.model,
        } for c in convs]
    })

@app.route("/api/conversations/<uuid>", methods=["GET"])
@login_required
def get_conversation(uuid):
    conv = Conversation.query.filter_by(uuid=uuid, user_id=current_user.id).first()
    if not conv:
        return jsonify({"error": "Not found"}), 404
    msgs = [{"role": m.role, "content": m.content, "timestamp": m.timestamp.isoformat() if m.timestamp else ""}
            for m in conv.messages.all()]
    return jsonify({"id": conv.uuid, "title": conv.title, "messages": msgs, "model": conv.model})

@app.route("/api/conversations/<uuid>", methods=["DELETE"])
@login_required
def delete_conversation(uuid):
    conv = Conversation.query.filter_by(uuid=uuid, user_id=current_user.id).first()
    if not conv:
        return jsonify({"error": "Not found"}), 404
    db.session.delete(conv)
    db.session.commit()
    return jsonify({"status": "deleted"})

@app.route("/api/conversations/<uuid>/title", methods=["PUT"])
@login_required
def update_conversation_title(uuid):
    data = request.get_json()
    conv = Conversation.query.filter_by(uuid=uuid, user_id=current_user.id).first()
    if not conv:
        return jsonify({"error": "Not found"}), 404
    conv.title = data.get("title", "New Chat")
    db.session.commit()
    return jsonify({"status": "updated"})

# ─── File Upload for Chat ────────────────────────────────────
ALLOWED_EXTENSIONS = {"txt", "pdf", "png", "jpg", "jpeg", "gif", "py", "js", "html", "css", "json", "csv", "md"}

@app.route("/api/upload", methods=["POST"])
@login_required
def api_upload_file():
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file"}), 400
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"error": f"File type .{ext} not allowed"}), 400
    filename = secure_filename(f"chat_{current_user.id}_{int(time.time())}_{file.filename}")
    path = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    file.save(path)
    # Read content for context
    content = ""
    try:
        if ext in ("png", "jpg", "jpeg", "gif"):
            content = f"[Image uploaded: {file.filename}]"
        else:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()[:5000]
    except:
        content = f"[File uploaded: {file.filename}]"
    return jsonify({"ok": True, "filename": file.filename, "content": content, "path": filename})

# ─── Chat API ────────────────────────────────────────────────
@app.route("/api/chat", methods=["POST"])
@login_required
def api_chat():
    data = request.get_json()
    user_message = data.get("message", "").strip()
    conv_uuid = data.get("conversation_id", "")
    model_name = data.get("model", DEFAULT_MODEL)
    if not user_message:
        return jsonify({"error": "Message is required"}), 400

    # Find or create conversation
    if conv_uuid:
        conv = Conversation.query.filter_by(uuid=conv_uuid, user_id=current_user.id).first()
        if not conv:
            return jsonify({"error": "Conversation not found"}), 404
    else:
        conv_uuid = f"conv_{int(time.time()*1000)}_{os.urandom(4).hex()}"
        conv = Conversation(uuid=conv_uuid, user_id=current_user.id,
                           title=user_message[:50] + ("..." if len(user_message)>50 else ""),
                           model=model_name)
        db.session.add(conv)
        db.session.commit()

    # Save user message
    msg_user = Message(conversation_id=conv.id, role="user", content=user_message)
    db.session.add(msg_user)
    db.session.commit()

    def generate():
        max_retries = 2
        for attempt in range(max_retries + 1):
            try:
                history = Message.query.filter_by(conversation_id=conv.id)\
                    .order_by(Message.timestamp).all()
                # Exclude the last message (the one we just saved) for history
                history = history[:-1]
                gemini_hist = format_history_for_gemini(history)
                chat_session = create_chat_session(model_name, gemini_hist if gemini_hist else None)
                response = chat_session.send_message_stream(user_message)

                full_response = ""
                for chunk in response:
                    if chunk.text:
                        text = chunk.text
                        full_response += text
                        yield f"data: {json.dumps({'type': 'chunk', 'content': text})}\n\n"

                msg_ai = Message(conversation_id=conv.id, role="model", content=full_response)
                db.session.add(msg_ai)
                db.session.commit()
                yield f"data: {json.dumps({'type': 'done', 'conversation_id': conv.uuid, 'full_content': full_response})}\n\n"
                return
            except Exception as e:
                error_msg = str(e)
                if is_quota_error(error_msg) and attempt < max_retries:
                    retry_seconds = extract_retry_seconds(error_msg) or (2 ** attempt)
                    yield f"data: {json.dumps({'type': 'chunk', 'content': f'⏳ Rate limit hit. Retrying in {retry_seconds+0.5:.0f}s...'})}\n\n"
                    time.sleep(retry_seconds + random.uniform(0, 0.5))
                    yield f"data: {json.dumps({'type': 'chunk', 'content': '🔄 Retrying...\n\n'})}\n\n"
                else:
                    if is_quota_error(error_msg):
                        yield f"data: {json.dumps({'type': 'quota_error', 'content': '⚠️ **API Rate Limit Reached**\n\nWait a minute or get a new API key at https://aistudio.google.com/apikey'})}\n\n"
                    else:
                        yield f"data: {json.dumps({'type': 'error', 'content': f'⚠️ Error: {error_msg}'})}\n\n"
                    return

    return Response(stream_with_context(generate()),
                    mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})

@app.route("/api/chat/regenerate", methods=["POST"])
@login_required
def api_regenerate():
    data = request.get_json()
    conv_uuid = data.get("conversation_id", "")
    model_name = data.get("model", DEFAULT_MODEL)
    if not conv_uuid:
        return jsonify({"error": "Conversation ID required"}), 400

    conv = Conversation.query.filter_by(uuid=conv_uuid, user_id=current_user.id).first()
    if not conv:
        return jsonify({"error": "Not found"}), 404

    all_msgs = Message.query.filter_by(conversation_id=conv.id).order_by(Message.timestamp).all()
    # Remove last AI message if exists
    if all_msgs and all_msgs[-1].role == "model":
        db.session.delete(all_msgs[-1])
        db.session.commit()
        all_msgs = all_msgs[:-1]
    if not all_msgs or all_msgs[-1].role != "user":
        return jsonify({"error": "No user message to regenerate from"}), 400

    user_message = all_msgs[-1].content
    history = all_msgs[:-1]

    def generate():
        max_retries = 2
        for attempt in range(max_retries + 1):
            try:
                gemini_hist = format_history_for_gemini(history)
                chat_session = create_chat_session(model_name, gemini_hist if gemini_hist else None)
                response = chat_session.send_message_stream(user_message)
                full_response = ""
                for chunk in response:
                    if chunk.text:
                        full_response += chunk.text
                        yield f"data: {json.dumps({'type': 'chunk', 'content': chunk.text})}\n\n"
                msg_ai = Message(conversation_id=conv.id, role="model", content=full_response)
                db.session.add(msg_ai)
                db.session.commit()
                yield f"data: {json.dumps({'type': 'done', 'conversation_id': conv.uuid, 'full_content': full_response})}\n\n"
                return
            except Exception as e:
                error_msg = str(e)
                if is_quota_error(error_msg) and attempt < max_retries:
                    retry_seconds = extract_retry_seconds(error_msg) or (2 ** attempt)
                    yield f"data: {json.dumps({'type': 'chunk', 'content': f'⏳ Retrying in {retry_seconds+0.5:.0f}s...'})}\n\n"
                    time.sleep(retry_seconds + random.uniform(0, 0.5))
                else:
                    if is_quota_error(error_msg):
                        yield f"data: {json.dumps({'type': 'quota_error', 'content': '⚠️ **API Rate Limit Reached**'})}\n\n"
                    else:
                        yield f"data: {json.dumps({'type': 'error', 'content': f'⚠️ {error_msg}'})}\n\n"
                    return

    return Response(stream_with_context(generate()),
                    mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})

# ─── Models API ──────────────────────────────────────────────
@app.route("/api/models", methods=["GET"])
def api_models():
    return jsonify({"models": AVAILABLE_MODELS})

# ─── Start ───────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("  AI Chatbot Pro - SQLite + Auth + Glassmorphism")
    print("  Open http://127.0.0.1:5000 in your browser")
    print("=" * 60)
    app.run(debug=True, threaded=True, port=5000)