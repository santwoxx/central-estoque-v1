import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore, enableMultiTabIndexedDbPersistence } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDXen38LRqBt2qkCkS2nlAPhWVhyZfwDs4",
  authDomain: "central-autocar.firebaseapp.com",
  projectId: "central-autocar",
  storageBucket: "central-autocar.firebasestorage.app",
  messagingSenderId: "560659713877",
  appId: "1:560659713877:web:6cb4be62d099494a5c29dc",
  measurementId: "G-3TLZZBS5RX"
};

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Authentication
export const auth = getAuth(app);

// Initialize Firestore on default database
export const db = getFirestore(app);

// Enable offline persistence
enableMultiTabIndexedDbPersistence(db).catch((err) => {
  console.error("Firestore persistence failed to enable:", err);
});
